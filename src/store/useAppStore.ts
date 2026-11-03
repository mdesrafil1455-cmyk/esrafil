import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Job,
  Transaction,
  ActiveWork,
  DepositRequest,
  WithdrawRequest,
  WalletState,
  TxnType,
  ProofSubmission,
  User,
  Settings,
  JobLevel,
  DepositMethod,
} from '@/types';
import { uid, genWorkId } from '@/lib/format';
import { awardReferralOnFirstDeposit } from '@/lib/supabase';

const CURRENT_USER_ID = 'u_me';
const ADMIN_ID = 'u_admin';

function seedUsers(): User[] {
  return [
    {
      id: CURRENT_USER_ID,
      name: 'You',
      avatar: '',
      email: '',
      level: 'Level 1',
      balance: 0,
      coins: 0,
      lifetimeEarnings: 0,
      totalDeposit: 0,
      totalWithdraw: 0,
      totalSpend: 0,
      totalPenalty: 0,
      blocked: false,
      createdAt: Date.now(),
      transactions: [],
    },
    {
      id: ADMIN_ID,
      name: 'Admin',
      avatar: '',
      email: 'admin@platform.bd',
      level: 'Level 3',
      balance: 0,
      coins: 0,
      lifetimeEarnings: 0,
      totalDeposit: 0,
      totalWithdraw: 0,
      totalSpend: 0,
      totalPenalty: 0,
      blocked: false,
      createdAt: Date.now(),
      transactions: [],
    },
  ];
}

function defaultJobs(): Job[] {
  return [];
}

interface AppState {
  seeded: boolean;
  currentUserId: string;
  isAdminMode: boolean;

  users: User[];
  jobs: Job[];
  transactions: Transaction[];
  activeWork: ActiveWork | null;
  deposits: DepositRequest[];
  withdrawals: WithdrawRequest[];
  proofs: ProofSubmission[];
  settings: Settings;

  // Computed helpers
  me: () => User;
  wallet: () => WalletState;
  jobsByPlatform: (p: string) => Job[];
  jobCountByPlatform: (p: string) => number;

  // Mode
  setAdminMode: (v: boolean) => void;

  // Job actions
  createJob: (input: {
    platform: Job['platform'];
    subTaskType: string;
    jobTitle: string;
    rate: number;
    totalWorkers: number;
    level: JobLevel;
    pageName: string;
    referenceScreenshot: string;
    pageLink?: string;
    commentLines: string[];
    instructions: string[];
  }) => { success: boolean; message: string };
  acceptJob: (jobId: string) => void;
  submitProof: (jobId: string, screenshots: string[]) => { success: boolean; message: string };
  cancelActiveWork: () => void;

  // Admin: proofs
  approveProof: (proofId: string) => void;
  rejectProof: (proofId: string, reason: string) => void;
  autoApproveExpiredProofs: () => void;

  // Admin: deposits / withdrawals
  approveDeposit: (id: string) => Promise<void>;
  rejectDeposit: (id: string) => void;
  approveWithdraw: (id: string) => void;
  rejectWithdraw: (id: string) => void;
  requestWithdraw: (amount: number, method: DepositMethod, receiverNumber: string) => { success: boolean; message: string };

  // Admin: users
  setUserLevel: (userId: string, level: JobLevel) => void;
  toggleBlockUser: (userId: string) => void;
  adjustBalance: (userId: string, delta: number, note: string) => void;

  // Admin: settings
  updateSettings: (s: Partial<Settings>) => void;

  // Deposit (worker side)
  requestDeposit: (input: { amount: number; method: DepositMethod; senderNumber: string; trxId: string; screenshot: string; supabaseUserId?: string }) => void;
}

function addTxn(user: User, type: TxnType, amount: number, description: string): Transaction[] {
  const txn: Transaction = { id: uid('txn_'), type, amount, description, createdAt: Date.now() };
  return [txn, ...user.transactions];
}

function computeBalance(u: Pick<User, 'totalDeposit' | 'lifetimeEarnings' | 'totalWithdraw' | 'totalSpend' | 'totalPenalty'>): number {
  return Math.max(0, u.totalDeposit + u.lifetimeEarnings - u.totalWithdraw - u.totalSpend - u.totalPenalty);
}

function applyTxn(user: User, type: TxnType, amount: number, description: string): User {
  const transactions = addTxn(user, type, amount, description);
  let { lifetimeEarnings, totalDeposit, totalWithdraw, totalSpend, totalPenalty, coins } = user;
  if (type === 'reward') { lifetimeEarnings += amount; coins += Math.round(amount * 10); }
  else if (type === 'deposit') { totalDeposit += amount; }
  else if (type === 'withdraw') { totalWithdraw += amount; }
  else if (type === 'spend') { totalSpend += amount; }
  else if (type === 'penalty') { totalPenalty += amount; }
  const balance = computeBalance({ totalDeposit, lifetimeEarnings, totalWithdraw, totalSpend, totalPenalty });
  return { ...user, balance, lifetimeEarnings, totalDeposit, totalWithdraw, totalSpend, totalPenalty, coins, transactions };
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      seeded: false,
      currentUserId: CURRENT_USER_ID,
      isAdminMode: false,

      users: [],
      jobs: [],
      transactions: [],
      activeWork: null,
      deposits: [],
      withdrawals: [],
      proofs: [],
      settings: { serviceChargePercent: 25, minWorkers: 5 },

      me: () => get().users.find((u) => u.id === get().currentUserId) ?? get().users[0],
      wallet: () => {
        const u = get().me();
        return {
          balance: computeBalance(u),
          coins: u.coins,
          lifetimeEarnings: u.lifetimeEarnings,
          totalDeposit: u.totalDeposit,
          totalWithdraw: u.totalWithdraw,
          totalSpend: u.totalSpend,
          totalPenalty: u.totalPenalty,
        };
      },
      jobsByPlatform: (p) => get().jobs.filter((j) => j.platform === p),
      jobCountByPlatform: (p) =>
        get().jobs.filter((j) => j.platform === p && j.status === 'Active' && j.availableSlots > 0).length,

      setAdminMode: (v) => set({ isAdminMode: v, currentUserId: v ? ADMIN_ID : CURRENT_USER_ID }),

      createJob: (input) => {
        const me = get().me();
        const settings = get().settings;
        if (input.totalWorkers < settings.minWorkers) {
          return { success: false, message: `Minimum ${settings.minWorkers} workers required.` };
        }
        const subtotal = input.rate * input.totalWorkers;
        const serviceCharge = subtotal * (settings.serviceChargePercent / 100);
        const totalCost = subtotal + serviceCharge;
        if (me.balance < totalCost) {
          return { success: false, message: `Insufficient balance. Need ৳${totalCost.toFixed(2)}, you have ৳${me.balance.toFixed(2)}.` };
        }
        // Deduct from buyer
        set((s) => ({
          users: s.users.map((u) =>
            u.id === me.id ? applyTxn(u, 'spend', totalCost, `Created task: ${input.jobTitle}`) : u
          ),
          jobs: [
            {
              id: uid('job_'),
              workId: genWorkId(),
              platform: input.platform,
              subTaskType: input.subTaskType,
              jobTitle: input.jobTitle,
              rate: input.rate,
              totalWorkers: input.totalWorkers,
              availableSlots: input.totalWorkers,
              level: input.level,
              locked: false,
              employerName: me.name,
              employerThumbnail: me.avatar,
              referenceScreenshot: input.referenceScreenshot,
              pageLink: input.pageLink,
              pageName: input.pageName,
              commentLines: input.commentLines,
              instructions: input.instructions,
              status: 'Active',
              subtotal,
              serviceCharge,
              totalCost,
              buyerId: me.id,
              createdAt: Date.now(),
            },
            ...s.jobs,
          ],
        }));
        return { success: true, message: `Task created! ৳${totalCost.toFixed(2)} deducted. It's now live in Work.` };
      },

      acceptJob: (jobId) => {
        const job = get().jobs.find((j) => j.id === jobId);
        if (!job || job.availableSlots <= 0) return;
        set({
          activeWork: { jobId, workId: job.workId, acceptedAt: Date.now() },
          jobs: get().jobs.map((j) =>
            j.id === jobId ? { ...j, availableSlots: j.availableSlots - 1 } : j
          ),
        });
      },

      cancelActiveWork: () => {
        const active = get().activeWork;
        if (!active) return;
        set({
          activeWork: null,
          jobs: get().jobs.map((j) =>
            j.id === active.jobId ? { ...j, availableSlots: j.availableSlots + 1 } : j
          ),
        });
      },

      submitProof: (jobId, screenshots) => {
        const active = get().activeWork;
        const job = get().jobs.find((j) => j.id === jobId);
        const me = get().me();
        if (!active || active.jobId !== jobId || !job) {
          return { success: false, message: 'No active work for this job.' };
        }
        const valid = screenshots.filter(Boolean);
        if (valid.length === 0) {
          return { success: false, message: 'Please upload at least one proof screenshot.' };
        }
        const proof: ProofSubmission = {
          id: uid('proof_'),
          jobId,
          workId: job.workId,
          workerId: me.id,
          workerName: me.name,
          screenshot: valid[0],
          screenshots: valid,
          status: 'Pending',
          reward: job.rate,
          submittedAt: Date.now(),
        };
        set((s) => ({
          activeWork: null,
          proofs: [proof, ...s.proofs],
          jobs: s.jobs.map((j) =>
            j.id === jobId ? { ...j, status: 'Pending' as const } : j
          ),
        }));
        return { success: true, message: 'Proof submitted! Status is now Pending. Admin will review it shortly.' };
      },

      approveProof: (proofId) => {
        const proof = get().proofs.find((p) => p.id === proofId);
        if (!proof || proof.status !== 'Pending') return;
        set((s) => ({
          proofs: s.proofs.map((p) =>
            p.id === proofId ? { ...p, status: 'Approved' as const, reviewedAt: Date.now() } : p
          ),
          users: s.users.map((u) =>
            u.id === proof.workerId
              ? applyTxn(u, 'reward', proof.reward, `Proof approved: ${proof.workId}`)
              : u
          ),
          jobs: s.jobs.map((j) =>
            j.id === proof.jobId
              ? { ...j, status: j.availableSlots <= 0 ? 'Completed' : 'Active' }
              : j
          ),
        }));
      },

      rejectProof: (proofId, reason) => {
        const proof = get().proofs.find((p) => p.id === proofId);
        if (!proof || proof.status !== 'Pending') return;
        set((s) => ({
          proofs: s.proofs.map((p) =>
            p.id === proofId ? { ...p, status: 'Rejected' as const, reviewedAt: Date.now(), rejectionReason: reason } : p
          ),
          jobs: s.jobs.map((j) =>
            j.id === proof.jobId
              ? { ...j, status: 'Active', availableSlots: j.availableSlots + 1 }
              : j
          ),
        }));
      },

      requestDeposit: (input) => {
        const me = get().me();
        set((s) => ({
          deposits: [
            { ...input, id: uid('dep_'), userId: me.id, userName: me.name, status: 'pending', createdAt: Date.now(), supabaseUserId: input.supabaseUserId },
            ...s.deposits,
          ],
        }));
      },

      approveDeposit: async (id) => {
        const dep = get().deposits.find((d) => d.id === id);
        if (!dep || dep.status !== 'pending') return;
        set((s) => ({
          deposits: s.deposits.map((d) => (d.id === id ? { ...d, status: 'approved' } : d)),
          users: s.users.map((u) =>
            u.id === dep.userId ? applyTxn(u, 'deposit', dep.amount, `Deposit approved: ${dep.method}`) : u
          ),
        }));
        if (dep.supabaseUserId) {
          await awardReferralOnFirstDeposit(dep.supabaseUserId);
        }
      },

      rejectDeposit: (id) => {
        const dep = get().deposits.find((d) => d.id === id);
        if (!dep || dep.status !== 'pending') return;
        set((s) => ({
          deposits: s.deposits.map((d) => (d.id === id ? { ...d, status: 'rejected' } : d)),
          users: s.users.map((u) =>
            u.id === dep.userId
              ? applyTxn(u, 'deposit_rejected', dep.amount, `Deposit rejected: ${dep.method}`)
              : u
          ),
        }));
      },

      requestWithdraw: (amount, method, receiverNumber) => {
        const me = get().me();
        if (amount < 50) return { success: false, message: 'সর্বনিম্ন উইথড্র অ্যামাউন্ট ৳৫০ হতে হবে।' };
        const charge = amount * (get().settings.serviceChargePercent / 100);
        const totalDeducted = amount + charge;
        if (me.balance < totalDeducted) {
          return { success: false, message: `পর্যাপ্ত ব্যালেন্স নেই! চার্জসহ মোট ৳${totalDeducted.toFixed(2)} টাকা ব্যালেন্সে থাকতে হবে।` };
        }
        set((s) => ({
          users: s.users.map((u) =>
            u.id === me.id ? applyTxn(u, 'withdraw', totalDeducted, `Withdraw: ${method} (Net ৳${amount.toFixed(2)} + Charge ৳${charge.toFixed(2)})`) : u
          ),
          withdrawals: [
            { id: uid('wd_'), userId: me.id, userName: me.name, amount, serviceCharge: charge, totalDeducted, method, receiverNumber, status: 'pending', createdAt: Date.now() },
            ...s.withdrawals,
          ],
        }));
        return { success: true, message: `উত্তোলনের রিকোয়েস্ট পাঠানো হয়েছে। ৳${totalDeducted.toFixed(2)} ব্যালেন্স থেকে কাটা হয়েছে (নেট ৳${amount.toFixed(2)} + চার্জ ৳${charge.toFixed(2)})।` };
      },

      approveWithdraw: (id) => {
        const wd = get().withdrawals.find((w) => w.id === id);
        if (!wd || wd.status !== 'pending') return;
        set((s) => ({ withdrawals: s.withdrawals.map((w) => (w.id === id ? { ...w, status: 'approved' } : w)) }));
      },

      rejectWithdraw: (id) => {
        const wd = get().withdrawals.find((w) => w.id === id);
        if (!wd || wd.status !== 'pending') return;
        set((s) => ({
          withdrawals: s.withdrawals.map((w) => (w.id === id ? { ...w, status: 'rejected' } : w)),
          users: s.users.map((u) =>
            u.id === wd.userId ? applyTxn(u, 'deposit', wd.totalDeducted, `Withdrawal rejected: refunded ৳${wd.totalDeducted.toFixed(2)}`) : u
          ),
        }));
      },

      setUserLevel: (userId, level) =>
        set((s) => ({ users: s.users.map((u) => (u.id === userId ? { ...u, level } : u)) })),

      toggleBlockUser: (userId) =>
        set((s) => ({ users: s.users.map((u) => (u.id === userId ? { ...u, blocked: !u.blocked } : u)) })),

      adjustBalance: (userId, delta, note) =>
        set((s) => ({
          users: s.users.map((u) =>
            u.id === userId
              ? applyTxn(u, delta >= 0 ? 'deposit' : 'penalty', Math.abs(delta), note)
              : u
          ),
        })),

      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      autoApproveExpiredProofs: () => {
        const now = Date.now();
        const AUTO_APPROVE_MS = 24 * 60 * 60 * 1000;
        const expired = get().proofs.filter(
          (p) => p.status === 'Pending' && now - p.submittedAt >= AUTO_APPROVE_MS
        );
        if (expired.length === 0) return;
        set((s) => ({
          proofs: s.proofs.map((p) =>
            p.status === 'Pending' && now - p.submittedAt >= AUTO_APPROVE_MS
              ? { ...p, status: 'Approved' as const, reviewedAt: now }
              : p
          ),
          users: s.users.map((u) => {
            const owed = expired
              .filter((p) => p.workerId === u.id)
              .reduce((sum, p) => sum + p.reward, 0);
            return owed > 0 ? applyTxn(u, 'reward', owed, `Auto-approved after 24h: ${expired.filter((p) => p.workerId === u.id).map((p) => p.workId).join(', ')}`) : u;
          }),
          jobs: s.jobs.map((j) => {
            const jobProofs = expired.filter((p) => p.jobId === j.id);
            if (jobProofs.length === 0) return j;
            return { ...j, status: j.availableSlots <= 0 ? 'Completed' : 'Active' };
          }),
        }));
      },
    }),
    {
      name: 'bdt-microjob-v3',
      partialize: (s) => ({
        seeded: s.seeded,
        users: s.users,
        jobs: s.jobs,
        deposits: s.deposits,
        withdrawals: s.withdrawals,
        proofs: s.proofs,
        settings: s.settings,
        activeWork: s.activeWork,
      }),
      onRehydrateStorage: () => (state) => {
        if (state && !state.seeded) {
          state.users = seedUsers();
          state.jobs = defaultJobs();
          state.seeded = true;
        }
      },
    }
  )
);

if (!useAppStore.getState().seeded) {
  useAppStore.setState({ users: seedUsers(), jobs: defaultJobs(), seeded: true });
}
