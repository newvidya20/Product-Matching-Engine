import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { apiClient } from '../api/client';
import {
  WorkspaceConfirmModal,
  type WorkspaceConfirmRequest,
} from '../components/ui/WorkspaceConfirmModal';
import type {
  AppModuleId,
  AuthenticatedGoogleUser,
  BorrowerAssessment,
  ConfigurableRuleField,
  PolicyReviewLogEntry,
  ProductCategory,
  ProductDocumentRecord,
  SubProduct,
  SystemSettings,
  WorkspaceConnectionConfig,
} from '../types/domain';

export interface ToastNotice {
  id: string;
  tone: 'success' | 'error' | 'info';
  message: string;
}

interface AppState {
  isLoading: boolean;
  loadError: string | null;
  isMutating: boolean;
  isGeneratingAi: boolean;
  isSigningIn: boolean;
  needsGoogleAuth: boolean;
  currentUser: AuthenticatedGoogleUser | null;
  workspaceConfig: WorkspaceConnectionConfig;
  activeModule: AppModuleId;
  selectedAssessmentId: string | null;
  selectedAdminCategoryId: string | null;
  selectedAdminTab: 'master' | 'pdfs' | 'verification' | 'logs';
  catalogViewMode: 'official_catalog' | 'fictional_demo_sandbox';
  categories: ProductCategory[];
  fictionalDemoCategories: ProductCategory[];
  assessments: BorrowerAssessment[];
  documents: ProductDocumentRecord[];
  policyLogs: PolicyReviewLogEntry[];
  settings: SystemSettings;
  toast: ToastNotice | null;
}

const initialSettings: SystemSettings = {
  organizationName: 'LoanBazaar Financial Services',
  internalUnitName: 'Internal Product Advisory & Matching Desk',
  defaultCurrency: 'INR',
  enableDemoSandbox: false,
  strict18CategorySlots: true,
  enableAiExplanationService: true,
  showFictionalRecordsInTables: false,
  themeMode: 'light',
  updatedAt: '',
};

const initialWorkspaceConfig: WorkspaceConnectionConfig = {
  spreadsheetId: '',
  spreadsheetTitle: '',
  spreadsheetUrl: '',
  driveFolderId: '',
  driveFolderName: '',
  adminEmails: ['viloanbazzar@gmail.com'],
  employeeEmails: [],
  connectedByEmail: '',
  lastSyncedAt: '',
};

const localWorkspaceUser: AuthenticatedGoogleUser = {
  uid: 'local-workspace',
  email: 'local@loanbazaar.internal',
  displayName: 'Local Workspace',
  role: 'admin',
};

const USERS_STORAGE_KEY = 'loanbazaar-local-users-v1';
const SESSION_STORAGE_KEY = 'loanbazaar-local-session-v1';

interface LocalUserRecord {
  uid: string;
  email: string;
  displayName: string;
  password: string;
  role: 'admin' | 'employee';
  createdAt: string;
}

function readStoredUsers(): LocalUserRecord[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(USERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as LocalUserRecord[]) : [];
  } catch {
    return [];
  }
}

function writeStoredUsers(users: LocalUserRecord[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(users));
}

function readStoredSessionUser(): AuthenticatedGoogleUser | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthenticatedGoogleUser>;
    if (!parsed || !parsed.email || !parsed.role) return null;
    return {
      uid: parsed.uid || `local-${parsed.email}`,
      email: parsed.email,
      displayName: parsed.displayName || parsed.email.split('@')[0],
      role: parsed.role === 'employee' ? 'employee' : 'admin',
    };
  } catch {
    return null;
  }
}

function writeStoredSessionUser(user: AuthenticatedGoogleUser | null) {
  if (typeof window === 'undefined') return;
  if (!user) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(user));
}

function isVerifiedAdminEmail(email: string, adminEmails: string[]) {
  const normalized = email.trim().toLowerCase();
  return adminEmails.some((item) => item.trim().toLowerCase() === normalized);
}

const getAccessToken = (): null => null;

const initialState: AppState = {
  isLoading: true,
  loadError: null,
  isMutating: false,
  isGeneratingAi: false,
  isSigningIn: false,
  needsGoogleAuth: false,
  currentUser: readStoredSessionUser(),
  workspaceConfig: initialWorkspaceConfig,
  activeModule: 'dashboard',
  selectedAssessmentId: null,
  selectedAdminCategoryId: 'cat-01',
  selectedAdminTab: 'master',
  catalogViewMode: 'official_catalog',
  categories: [],
  fictionalDemoCategories: [],
  assessments: [],
  documents: [],
  policyLogs: [],
  settings: initialSettings,
  toast: null,
};

type Action =
  | { type: 'BOOTSTRAP_START' }
  | {
      type: 'BOOTSTRAP_SUCCESS';
      payload: {
        categories: ProductCategory[];
        fictionalDemoCategories: ProductCategory[];
        assessments: BorrowerAssessment[];
        documents: ProductDocumentRecord[];
        policyLogs: PolicyReviewLogEntry[];
        settings: SystemSettings;
        workspaceConfig: WorkspaceConnectionConfig;
        currentUser: AuthenticatedGoogleUser | null;
      };
    }
  | { type: 'BOOTSTRAP_ERROR'; error: string }
  | { type: 'SET_AUTH_STATE'; user: AuthenticatedGoogleUser | null; needsAuth: boolean }
  | { type: 'SET_SIGNING_IN'; flag: boolean }
  | { type: 'SET_WORKSPACE_CONFIG'; workspaceConfig: WorkspaceConnectionConfig }
  | { type: 'SET_MODULE'; moduleId: AppModuleId }
  | { type: 'SET_SELECTED_ASSESSMENT'; assessmentId: string | null }
  | { type: 'SET_ADMIN_CATEGORY'; categoryId: string }
  | { type: 'SET_ADMIN_TAB'; tab: 'master' | 'pdfs' | 'verification' | 'logs' }
  | { type: 'SET_CATALOG_VIEW_MODE'; mode: 'official_catalog' | 'fictional_demo_sandbox' }
  | { type: 'MUTATION_START' }
  | { type: 'MUTATION_END' }
  | { type: 'AI_START' }
  | { type: 'AI_END' }
  | {
      type: 'SYNC_CATALOG';
      categories: ProductCategory[];
      fictionalDemoCategories: ProductCategory[];
      documents?: ProductDocumentRecord[];
      policyLogs?: PolicyReviewLogEntry[];
    }
  | {
      type: 'UPSERT_CATEGORY';
      category: ProductCategory;
      fictionalDemoCategories?: ProductCategory[];
      policyLogs?: PolicyReviewLogEntry[];
    }
  | { type: 'UPSERT_ASSESSMENT'; assessment: BorrowerAssessment }
  | { type: 'REMOVE_ASSESSMENT'; assessmentId: string }
  | { type: 'SET_ASSESSMENTS'; assessments: BorrowerAssessment[] }
  | { type: 'SET_SETTINGS'; settings: SystemSettings }
  | { type: 'SET_TOAST'; toast: ToastNotice | null };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'BOOTSTRAP_START':
      return { ...state, isLoading: true, loadError: null };
    case 'BOOTSTRAP_SUCCESS': {
      const firstAssessment = action.payload.assessments[0]?.id ?? null;
      const firstCat = action.payload.categories[0]?.id ?? 'cat-01';
      return {
        ...state,
        isLoading: false,
        loadError: null,
        categories: action.payload.categories,
        fictionalDemoCategories: action.payload.fictionalDemoCategories,
        assessments: action.payload.assessments,
        documents: action.payload.documents || [],
        policyLogs: action.payload.policyLogs || [],
        settings: action.payload.settings,
        workspaceConfig: action.payload.workspaceConfig,
        currentUser: action.payload.currentUser ?? state.currentUser,
        needsGoogleAuth: false,
        selectedAssessmentId: state.selectedAssessmentId || firstAssessment,
        selectedAdminCategoryId: state.selectedAdminCategoryId || firstCat,
      };
    }
    case 'BOOTSTRAP_ERROR':
      return { ...state, isLoading: false, loadError: action.error };
    case 'SET_AUTH_STATE':
      return {
        ...state,
        currentUser: action.user,
        needsGoogleAuth: action.needsAuth,
      };
    case 'SET_SIGNING_IN':
      return { ...state, isSigningIn: action.flag };
    case 'SET_WORKSPACE_CONFIG':
      return { ...state, workspaceConfig: action.workspaceConfig };
    case 'SET_MODULE':
      return { ...state, activeModule: action.moduleId };
    case 'SET_SELECTED_ASSESSMENT':
      return { ...state, selectedAssessmentId: action.assessmentId };
    case 'SET_ADMIN_CATEGORY':
      return { ...state, selectedAdminCategoryId: action.categoryId };
    case 'SET_ADMIN_TAB':
      return { ...state, selectedAdminTab: action.tab };
    case 'SET_CATALOG_VIEW_MODE':
      return { ...state, catalogViewMode: action.mode };
    case 'MUTATION_START':
      return { ...state, isMutating: true };
    case 'MUTATION_END':
      return { ...state, isMutating: false };
    case 'AI_START':
      return { ...state, isGeneratingAi: true };
    case 'AI_END':
      return { ...state, isGeneratingAi: false };
    case 'SYNC_CATALOG':
      return {
        ...state,
        categories: action.categories,
        fictionalDemoCategories: action.fictionalDemoCategories,
        documents: action.documents ?? state.documents,
        policyLogs: action.policyLogs ?? state.policyLogs,
      };
    case 'UPSERT_CATEGORY': {
      const exists = state.categories.some((c) => c.id === action.category.id);
      const nextCategories = exists
        ? state.categories.map((c) =>
            c.id === action.category.id ? action.category : c
          )
        : [...state.categories, action.category];
      return {
        ...state,
        categories: nextCategories,
        fictionalDemoCategories:
          action.fictionalDemoCategories ?? state.fictionalDemoCategories,
        policyLogs: action.policyLogs ?? state.policyLogs,
      };
    }
    case 'UPSERT_ASSESSMENT': {
      const exists = state.assessments.some((a) => a.id === action.assessment.id);
      const nextAssessments = exists
        ? state.assessments.map((a) =>
            a.id === action.assessment.id ? action.assessment : a
          )
        : [action.assessment, ...state.assessments];
      return {
        ...state,
        assessments: nextAssessments,
        selectedAssessmentId: action.assessment.id,
      };
    }
    case 'REMOVE_ASSESSMENT': {
      const filtered = state.assessments.filter(
        (a) => a.id !== action.assessmentId
      );
      return {
        ...state,
        assessments: filtered,
        selectedAssessmentId:
          state.selectedAssessmentId === action.assessmentId
            ? filtered[0]?.id ?? null
            : state.selectedAssessmentId,
      };
    }
    case 'SET_ASSESSMENTS':
      return {
        ...state,
        assessments: action.assessments,
        selectedAssessmentId: action.assessments[0]?.id ?? null,
      };
    case 'SET_SETTINGS':
      return {
        ...state,
        settings: action.settings,
        catalogViewMode:
          !action.settings.enableDemoSandbox &&
          state.catalogViewMode === 'fictional_demo_sandbox'
            ? 'official_catalog'
            : state.catalogViewMode,
      };
    case 'SET_TOAST':
      return { ...state, toast: action.toast };
    default:
      return state;
  }
}

interface AppContextValue {
  state: AppState;
  refreshBootstrap: () => Promise<void>;
  requestWorkspaceConfirmation: (req: WorkspaceConfirmRequest) => Promise<boolean>;
  createMasterSheet: (title?: string) => Promise<boolean>;
  connectExistingSheet: (idOrUrl: string) => Promise<boolean>;
  syncGoogleSheetsNow: () => Promise<void>;
  applyWorkspaceImportResult: (payload: {
    categories: ProductCategory[];
    fictionalDemoCategories: ProductCategory[];
    documents: ProductDocumentRecord[];
    policyLogs: PolicyReviewLogEntry[];
    workspaceConfig: WorkspaceConnectionConfig;
  }) => void;
  createStudyMaterialFolder: (folderName?: string) => Promise<boolean>;
  updateAccessControl: (adminEmails: string[], employeeEmails: string[]) => Promise<void>;
  uploadPdfToDrive: (payload: {
    fileName: string;
    base64Pdf: string;
    categoryId: string;
    subProductId?: string;
  }) => Promise<ProductDocumentRecord | null>;
  linkExistingDrivePdf: (payload: {
    driveFileId: string;
    fileName: string;
    webViewLink?: string;
    categoryId: string;
    subProductId?: string;
  }) => Promise<ProductDocumentRecord | null>;
  extractPdfDraftWithAi: (documentId: string, fileName: string) => Promise<boolean>;
  verifyRuleDecision: (payload: {
    categoryId: string;
    subProductId?: string;
    ruleId?: string;
    decision: 'verified' | 'rejected';
    updatedRule?: Partial<ConfigurableRuleField>;
    activateProduct?: boolean;
    summaryLabel: string;
  }) => Promise<void>;
  verifyAllDraftRules: () => Promise<void>;
  navigateTo: (moduleId: AppModuleId) => void;
  openAdminTab: (tab: 'master' | 'pdfs' | 'verification' | 'logs') => void;
  openAssessmentInEngine: (assessmentId: string) => void;
  openCategoryInAdmin: (categoryId: string) => void;
  setCatalogViewMode: (mode: 'official_catalog' | 'fictional_demo_sandbox') => void;
  setSelectedAssessmentId: (id: string | null) => void;
  setSelectedAdminCategoryId: (id: string) => void;
  signInLocalUser: (payload: {
    email: string;
    password: string;
    role?: 'admin' | 'employee';
    displayName?: string;
  }) => Promise<void>;
  signUpLocalUser: (payload: {
    displayName: string;
    email: string;
    password: string;
    role?: 'admin' | 'employee';
  }) => Promise<void>;
  signOut: () => void;
  notify: (tone: ToastNotice['tone'], message: string) => void;
  clearToast: () => void;
  createAssessment: (
    payload: Partial<BorrowerAssessment>,
    openEngineAfter?: boolean
  ) => Promise<BorrowerAssessment | null>;
  updateAssessment: (
    assessmentId: string,
    payload: Partial<BorrowerAssessment>
  ) => Promise<BorrowerAssessment | null>;
  deleteAssessment: (assessmentId: string) => Promise<void>;
  evaluateAssessment: (
    assessmentId: string,
    datasetMode: 'official_catalog' | 'fictional_demo_sandbox'
  ) => Promise<void>;
  generateAiExplanation: (assessmentId: string) => Promise<void>;
  saveCategory: (categoryId: string, payload: Partial<ProductCategory>) => Promise<void>;
  addCategorySlot: (payload: Partial<ProductCategory>) => Promise<void>;
  addSubProduct: (
    categoryId: string,
    payload: Partial<SubProduct>
  ) => Promise<SubProduct | null>;
  saveSubProduct: (
    categoryId: string,
    subProductId: string,
    payload: Partial<SubProduct>
  ) => Promise<void>;
  removeSubProduct: (categoryId: string, subProductId: string) => Promise<void>;
  importCatalogConfig: (categories: ProductCategory[]) => Promise<boolean>;
  resetCatalogPlaceholders: () => Promise<void>;
  resetDemoAssessments: () => Promise<void>;
  saveSettings: (payload: Partial<SystemSettings>) => Promise<void>;
}

const AppStateContext = createContext<AppContextValue | undefined>(undefined);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Mandatory Workspace Confirmation Modal state
  const [confirmReq, setConfirmReq] = useState<WorkspaceConfirmRequest | null>(
    null
  );
  const confirmResolverRef = useRef<((accepted: boolean) => void) | null>(null);

  const requestWorkspaceConfirmation = useCallback(
    (req: WorkspaceConfirmRequest): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        confirmResolverRef.current = resolve;
        setConfirmReq(req);
      });
    },
    []
  );

  const handleConfirmResolve = (accepted: boolean) => {
    setConfirmReq(null);
    if (confirmResolverRef.current) {
      confirmResolverRef.current(accepted);
      confirmResolverRef.current = null;
    }
  };

  // Helper that requests confirmation ONLY when Google Sheets/Drive will be written to
  const confirmIfSheetsConnected = useCallback(
    async (req: WorkspaceConfirmRequest): Promise<boolean> => {
      if (!getAccessToken() || !state.workspaceConfig.spreadsheetId) {
        return true;
      }
      return requestWorkspaceConfirmation(req);
    },
    [requestWorkspaceConfirmation, state.workspaceConfig.spreadsheetId]
  );

  const notify = useCallback((tone: ToastNotice['tone'], message: string) => {
    const id = `toast-${Date.now()}`;
    dispatch({ type: 'SET_TOAST', toast: { id, tone, message } });
  }, []);

  const signInLocalUser = useCallback(
    async (payload: {
      email: string;
      password: string;
      role?: 'admin' | 'employee';
      displayName?: string;
    }) => {
      const email = payload.email.trim().toLowerCase();
      const password = payload.password.trim();

      if (!email || !password) {
        notify('error', 'Email and password are required.');
        return;
      }

      if (password.length < 6) {
        notify('error', 'Password must be at least 6 characters long.');
        return;
      }

      const users = readStoredUsers();
      const existingUser = users.find((user) => user.email.toLowerCase() === email);

      if (!existingUser) {
        notify('error', 'No account found for this email. Please create an account first.');
        return;
      }

      if (existingUser.password !== password) {
        notify('error', 'Incorrect password. Please try again.');
        return;
      }

      const authenticatedUser: AuthenticatedGoogleUser = {
        uid: existingUser.uid,
        email: existingUser.email,
        displayName: existingUser.displayName,
        role: existingUser.role,
      };

      writeStoredSessionUser(authenticatedUser);
      dispatch({ type: 'SET_AUTH_STATE', user: authenticatedUser, needsAuth: false });
      notify(
        'success',
        `Signed in as ${authenticatedUser.role === 'admin' ? 'Administrator' : 'Employee'}.`
      );
    },
    [notify]
  );

  const signUpLocalUser = useCallback(
    async (payload: {
      displayName: string;
      email: string;
      password: string;
      role?: 'admin' | 'employee';
    }) => {
      const email = payload.email.trim().toLowerCase();
      const displayName = payload.displayName.trim();
      const password = payload.password.trim();
      const selectedRole = payload.role === 'employee' ? 'employee' : 'admin';

      if (!displayName) {
        notify('error', 'Please enter your full name.');
        return;
      }

      if (!email || !password) {
        notify('error', 'Email and password are required.');
        return;
      }

      if (password.length < 6) {
        notify('error', 'Password must be at least 6 characters long.');
        return;
      }

      const users = readStoredUsers();
      if (users.some((user) => user.email.toLowerCase() === email)) {
        notify('error', 'An account already exists for this email. Please sign in instead.');
        return;
      }

      const adminWhitelist = Array.from(
        new Set([
          ...initialWorkspaceConfig.adminEmails,
          ...state.workspaceConfig.adminEmails,
          'viloanbazzar@gmail.com',
          'admin@loanbazaar.local',
        ])
      );

      if (selectedRole === 'admin' && !isVerifiedAdminEmail(email, adminWhitelist)) {
        notify(
          'error',
          'Admin access is restricted to verified LoanBazaar administrators. Please use an approved admin email.'
        );
        return;
      }

      const nextUser: LocalUserRecord = {
        uid: `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        email,
        displayName,
        password,
        role: selectedRole,
        createdAt: new Date().toISOString(),
      };

      const nextUsers = [...users, nextUser];
      writeStoredUsers(nextUsers);

      const authenticatedUser: AuthenticatedGoogleUser = {
        uid: nextUser.uid,
        email: nextUser.email,
        displayName: nextUser.displayName,
        role: nextUser.role,
      };

      writeStoredSessionUser(authenticatedUser);
      dispatch({ type: 'SET_AUTH_STATE', user: authenticatedUser, needsAuth: false });
      notify('success', `Account created for ${displayName}. You are now signed in.`);
    },
    [notify, state.workspaceConfig.adminEmails]
  );

  const signOut = useCallback(() => {
    writeStoredSessionUser(null);
    dispatch({ type: 'SET_AUTH_STATE', user: null, needsAuth: false });
    notify('info', 'You have been signed out.');
  }, [notify]);

  const clearToast = useCallback(() => {
    dispatch({ type: 'SET_TOAST', toast: null });
  }, []);

  useEffect(() => {
    if (!state.toast) return;
    const timer = window.setTimeout(() => {
      dispatch({ type: 'SET_TOAST', toast: null });
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [state.toast]);

  useEffect(() => {
    writeStoredSessionUser(state.currentUser);
  }, [state.currentUser]);

  const refreshBootstrap = useCallback(async () => {
    dispatch({ type: 'BOOTSTRAP_START' });
    try {
      const data = await apiClient.bootstrap();
      dispatch({ type: 'BOOTSTRAP_SUCCESS', payload: data });
    } catch (err) {
      dispatch({
        type: 'BOOTSTRAP_ERROR',
        error:
          err instanceof Error
            ? err.message
            : 'Unable to connect to LoanBazaar API.',
      });
    }
  }, []);

  useEffect(() => {
    void refreshBootstrap();
  }, [refreshBootstrap]);

  const createMasterSheet = useCallback(
    async (title?: string) => {
      if (!getAccessToken()) {
        notify('error', 'Sign in with Google first.');
        return false;
      }
      const sheetName = title?.trim() || 'LoanBazaar – AI Product Matching Master';
      const confirmed = await requestWorkspaceConfirmation({
        title: 'Create Google Sheets Master Workbook?',
        description:
          'This will create a new Google Spreadsheet in your Google Drive with all 7 LoanBazaar tabs (Product_Categories, Sub_Products, Eligibility_Rules, Product_Documents, Borrower_Assessments, Matching_Results, Policy_Review_Log) and sync the 18 category slots.',
        affectedTarget: sheetName,
        confirmLabel: 'Create 7-Tab Spreadsheet',
      });
      if (!confirmed) return false;

      dispatch({ type: 'MUTATION_START' });
      try {
        const res = await apiClient.createMasterSpreadsheet(sheetName);
        dispatch({
          type: 'SET_WORKSPACE_CONFIG',
          workspaceConfig: res.workspaceConfig,
        });
        notify(
          'success',
          `Created and connected Google Sheet "${res.workspaceConfig.spreadsheetTitle}".`
        );
        return true;
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to create Google Sheet.'
        );
        return false;
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [notify, requestWorkspaceConfirmation]
  );

  const connectExistingSheet = useCallback(
    async (idOrUrl: string) => {
      if (!getAccessToken()) {
        notify('error', 'Sign in with Google first.');
        return false;
      }
      const confirmed = await requestWorkspaceConfirmation({
        title: 'Connect & Verify Google Spreadsheet?',
        description:
          'This will connect the selected Google Spreadsheet, create any missing tabs among the 7 required LoanBazaar sheets without overwriting existing rows, and load its live Product Master.',
        affectedTarget: idOrUrl,
        confirmLabel: 'Connect Spreadsheet',
      });
      if (!confirmed) return false;

      dispatch({ type: 'MUTATION_START' });
      try {
        const res = await apiClient.connectSpreadsheet(idOrUrl);
        dispatch({
          type: 'SET_WORKSPACE_CONFIG',
          workspaceConfig: res.workspaceConfig,
        });
        dispatch({
          type: 'SYNC_CATALOG',
          categories: res.categories,
          fictionalDemoCategories: res.fictionalDemoCategories,
          documents: res.documents,
          policyLogs: res.policyLogs,
        });
        dispatch({ type: 'SET_ASSESSMENTS', assessments: res.assessments });
        notify(
          'success',
          `Connected "${res.workspaceConfig.spreadsheetTitle}" and synced all 7 sheets.`
        );
        return true;
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to connect Google Sheet.'
        );
        return false;
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [notify, requestWorkspaceConfirmation]
  );

  const syncGoogleSheetsNow = useCallback(async () => {
    if (!getAccessToken()) {
      notify('error', 'Sign in with Google to sync Google Sheets.');
      return;
    }
    dispatch({ type: 'MUTATION_START' });
    try {
      const res = await apiClient.syncFromGoogleSheets();
      dispatch({
        type: 'SYNC_CATALOG',
        categories: res.categories,
        fictionalDemoCategories: res.fictionalDemoCategories,
        documents: res.documents,
        policyLogs: res.policyLogs,
      });
      dispatch({ type: 'SET_ASSESSMENTS', assessments: res.assessments });
      dispatch({
        type: 'SET_WORKSPACE_CONFIG',
        workspaceConfig: res.workspaceConfig,
      });
      notify('success', 'Synchronized latest approved data from Google Sheets.');
    } catch (err) {
      notify(
        'error',
        err instanceof Error ? err.message : 'Google Sheets sync failed.'
      );
    } finally {
      dispatch({ type: 'MUTATION_END' });
    }
  }, [notify]);

  const applyWorkspaceImportResult = useCallback(
    (payload: {
      categories: ProductCategory[];
      fictionalDemoCategories: ProductCategory[];
      documents: ProductDocumentRecord[];
      policyLogs: PolicyReviewLogEntry[];
      workspaceConfig: WorkspaceConnectionConfig;
    }) => {
      dispatch({
        type: 'SYNC_CATALOG',
        categories: payload.categories,
        fictionalDemoCategories: payload.fictionalDemoCategories,
        documents: payload.documents,
        policyLogs: payload.policyLogs,
      });
      dispatch({
        type: 'SET_WORKSPACE_CONFIG',
        workspaceConfig: payload.workspaceConfig,
      });
    },
    []
  );

  const createStudyMaterialFolder = useCallback(
    async (folderName?: string) => {
      if (!getAccessToken()) {
        notify('error', 'Sign in with Google first.');
        return false;
      }
      const targetName =
        folderName?.trim() || 'LoanBazaar Product Study Materials';
      const confirmed = await requestWorkspaceConfirmation({
        title: 'Create Google Drive PDF Folder?',
        description:
          'This will create a dedicated folder in your Google Drive to store uploaded LoanBazaar PDF study materials.',
        affectedTarget: targetName,
        confirmLabel: 'Create Drive Folder',
      });
      if (!confirmed) return false;

      dispatch({ type: 'MUTATION_START' });
      try {
        const res = await apiClient.createDriveFolder(targetName);
        dispatch({
          type: 'SET_WORKSPACE_CONFIG',
          workspaceConfig: res.workspaceConfig,
        });
        notify(
          'success',
          `Created Google Drive folder "${res.workspaceConfig.driveFolderName}".`
        );
        return true;
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to create Drive folder.'
        );
        return false;
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [notify, requestWorkspaceConfirmation]
  );

  const updateAccessControl = useCallback(
    async (adminEmails: string[], employeeEmails: string[]) => {
      dispatch({ type: 'MUTATION_START' });
      try {
        const res = await apiClient.updateWorkspaceAccess({
          adminEmails,
          employeeEmails,
        });
        dispatch({
          type: 'SET_WORKSPACE_CONFIG',
          workspaceConfig: res.workspaceConfig,
        });
        notify('success', 'Updated Admin & Employee access permissions.');
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to update access control.'
        );
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [notify]
  );

  const uploadPdfToDrive = useCallback(
    async (payload: {
      fileName: string;
      base64Pdf: string;
      categoryId: string;
      subProductId?: string;
    }) => {
      if (!getAccessToken()) {
        notify('error', 'Sign in with Google first to upload PDFs to Google Drive.');
        return null;
      }
      const confirmed = await requestWorkspaceConfirmation({
        title: 'Upload PDF to Google Drive & Update Sheet?',
        description:
          'This will upload the selected PDF study material to your Google Drive and append a linked document record in the Product_Documents sheet.',
        affectedTarget: `${payload.fileName} -> ${
          state.workspaceConfig.driveFolderName || 'Google Drive'
        }`,
        confirmLabel: 'Upload & Link PDF',
      });
      if (!confirmed) return null;

      dispatch({ type: 'MUTATION_START' });
      try {
        const res = await apiClient.uploadPdfDocument(payload);
        dispatch({
          type: 'SYNC_CATALOG',
          categories: res.categories,
          fictionalDemoCategories: state.fictionalDemoCategories,
          documents: res.documents,
          policyLogs: res.policyLogs,
        });
        notify('success', `Uploaded "${res.document.fileName}" to Google Drive.`);
        return res.document;
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'PDF upload failed.'
        );
        return null;
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [
      notify,
      requestWorkspaceConfirmation,
      state.fictionalDemoCategories,
      state.workspaceConfig.driveFolderName,
    ]
  );

  const linkExistingDrivePdf = useCallback(
    async (payload: {
      driveFileId: string;
      fileName: string;
      webViewLink?: string;
      categoryId: string;
      subProductId?: string;
    }) => {
      if (!getAccessToken()) {
        notify('error', 'Sign in with Google first.');
        return null;
      }
      const confirmed = await confirmIfSheetsConnected({
        title: 'Link Google Drive PDF in Product_Documents?',
        description:
          'This will link the selected Google Drive PDF to the chosen product slot and record it in Google Sheets.',
        affectedTarget: payload.fileName,
        confirmLabel: 'Link PDF',
      });
      if (!confirmed) return null;

      dispatch({ type: 'MUTATION_START' });
      try {
        const res = await apiClient.linkDrivePdfDocument(payload);
        dispatch({
          type: 'SYNC_CATALOG',
          categories: res.categories,
          fictionalDemoCategories: state.fictionalDemoCategories,
          documents: res.documents,
          policyLogs: res.policyLogs,
        });
        notify('success', `Linked "${res.document.fileName}" from Google Drive.`);
        return res.document;
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to link Drive PDF.'
        );
        return null;
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [confirmIfSheetsConnected, notify, state.fictionalDemoCategories]
  );

  const extractPdfDraftWithAi = useCallback(
    async (documentId: string, fileName: string) => {
      if (!getAccessToken()) {
        notify('error', 'Sign in with Google first to read the PDF from Drive.');
        return false;
      }
      const confirmed = await confirmIfSheetsConnected({
        title: 'Save AI-Extracted Draft Records to Google Sheets?',
        description:
          'Gemini will extract product metadata and eligibility rules strictly from this PDF and save them as unverified DRAFT rows in Sub_Products, Eligibility_Rules, and Product_Documents. Rules will NOT become active until verified by an Admin.',
        affectedTarget: `${fileName} -> Draft Rows in Google Sheets`,
        confirmLabel: 'Extract & Save Drafts',
      });
      if (!confirmed) return false;

      dispatch({ type: 'AI_START' });
      try {
        const res = await apiClient.extractPdfPolicyDraft(documentId);
        dispatch({
          type: 'SYNC_CATALOG',
          categories: res.categories,
          fictionalDemoCategories: res.fictionalDemoCategories,
          documents: res.documents,
          policyLogs: res.policyLogs,
        });
        notify(
          'success',
          `Extracted draft specifications and candidate rules from "${fileName}". Review in Verification Queue.`
        );
        return true;
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'AI PDF policy extraction failed.'
        );
        return false;
      } finally {
        dispatch({ type: 'AI_END' });
      }
    },
    [confirmIfSheetsConnected, notify]
  );

  const verifyRuleDecision = useCallback(
    async (payload: {
      categoryId: string;
      subProductId?: string;
      ruleId?: string;
      decision: 'verified' | 'rejected';
      updatedRule?: Partial<ConfigurableRuleField>;
      activateProduct?: boolean;
      summaryLabel: string;
    }) => {
      const confirmed = await confirmIfSheetsConnected({
        title:
          payload.decision === 'verified'
            ? 'Verify & Activate Eligibility Rule(s) in Google Sheets?'
            : 'Reject Draft Rule(s) in Google Sheets?',
        description:
          payload.decision === 'verified'
            ? 'This will update Eligibility_Rules to verified status, activate the product in Google Sheets, and record an audit entry in Policy_Review_Log.'
            : 'This will mark the draft rule(s) as rejected in Eligibility_Rules and log the review decision in Policy_Review_Log.',
        affectedTarget: payload.summaryLabel,
        confirmLabel:
          payload.decision === 'verified' ? 'Verify & Activate' : 'Reject Rule',
        isDestructive: payload.decision === 'rejected',
      });
      if (!confirmed) return;

      dispatch({ type: 'MUTATION_START' });
      try {
        const res = await apiClient.verifyExtractedRules(payload);
        dispatch({
          type: 'SYNC_CATALOG',
          categories: res.categories,
          fictionalDemoCategories: res.fictionalDemoCategories,
          documents: res.documents,
          policyLogs: res.policyLogs,
        });
        notify(
          'success',
          payload.decision === 'verified'
            ? 'Verified and activated eligibility rules.'
            : 'Marked draft rule as rejected.'
        );
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to update rule verification.'
        );
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [confirmIfSheetsConnected, notify]
  );

  const verifyAllDraftRules = useCallback(async () => {
    const confirmed = await confirmIfSheetsConnected({
      title: 'Verify & Activate All Pending Draft Rules in Google Sheets?',
      description:
        'This will approve all pending AI-extracted draft rules across all 19 category slots, activate their products in Google Sheets, and append an audit entry in Policy_Review_Log.',
      affectedTarget: `${state.workspaceConfig.spreadsheetTitle || 'Product Master'} (All Draft Rules)`,
      confirmLabel: 'Verify & Activate All',
    });
    if (!confirmed) return;

    dispatch({ type: 'MUTATION_START' });
    try {
      const res = await apiClient.verifyAllExtractedRules();
      dispatch({
        type: 'SYNC_CATALOG',
        categories: res.categories,
        fictionalDemoCategories: res.fictionalDemoCategories,
        documents: res.documents,
        policyLogs: res.policyLogs,
      });
      notify(
        'success',
        `Verified and activated ${res.verifiedRulesCount} eligibility rule(s) across your Product Master.`
      );
    } catch (err) {
      notify(
        'error',
        err instanceof Error ? err.message : 'Bulk rule verification failed.'
      );
    } finally {
      dispatch({ type: 'MUTATION_END' });
    }
  }, [
    confirmIfSheetsConnected,
    notify,
    state.workspaceConfig.spreadsheetTitle,
  ]);

  const navigateTo = useCallback((moduleId: AppModuleId) => {
    dispatch({ type: 'SET_MODULE', moduleId });
  }, []);

  const openAdminTab = useCallback(
    (tab: 'master' | 'pdfs' | 'verification' | 'logs') => {
      dispatch({ type: 'SET_ADMIN_TAB', tab });
      dispatch({ type: 'SET_MODULE', moduleId: 'admin' });
    },
    []
  );

  const openAssessmentInEngine = useCallback((assessmentId: string) => {
    dispatch({ type: 'SET_SELECTED_ASSESSMENT', assessmentId });
    dispatch({ type: 'SET_MODULE', moduleId: 'matching-engine' });
  }, []);

  const openCategoryInAdmin = useCallback((categoryId: string) => {
    dispatch({ type: 'SET_ADMIN_CATEGORY', categoryId });
    dispatch({ type: 'SET_ADMIN_TAB', tab: 'master' });
    dispatch({ type: 'SET_MODULE', moduleId: 'admin' });
  }, []);

  const setCatalogViewMode = useCallback(
    (mode: 'official_catalog' | 'fictional_demo_sandbox') => {
      dispatch({ type: 'SET_CATALOG_VIEW_MODE', mode });
    },
    []
  );

  const setSelectedAssessmentId = useCallback((assessmentId: string | null) => {
    dispatch({ type: 'SET_SELECTED_ASSESSMENT', assessmentId });
  }, []);

  const setSelectedAdminCategoryId = useCallback((categoryId: string) => {
    dispatch({ type: 'SET_ADMIN_CATEGORY', categoryId });
  }, []);

  const createAssessment = useCallback(
    async (payload: Partial<BorrowerAssessment>, openEngineAfter = false) => {
      const confirmed = await confirmIfSheetsConnected({
        title: 'Save Borrower Assessment to Google Sheets?',
        description:
          'This will append the borrower assessment record to the Borrower_Assessments tab in your connected Google Spreadsheet.',
        affectedTarget: `${payload.applicantLabel || 'New Borrower'} -> Borrower_Assessments`,
        confirmLabel: 'Save Assessment',
      });
      if (!confirmed) return null;

      dispatch({ type: 'MUTATION_START' });
      try {
        const { assessment } = await apiClient.createAssessment(payload);
        dispatch({ type: 'UPSERT_ASSESSMENT', assessment });
        notify('success', `Saved borrower intake ${assessment.referenceCode}.`);
        if (openEngineAfter) {
          dispatch({ type: 'SET_MODULE', moduleId: 'matching-engine' });
        }
        return assessment;
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to create assessment.'
        );
        return null;
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [confirmIfSheetsConnected, notify]
  );

  const updateAssessment = useCallback(
    async (assessmentId: string, payload: Partial<BorrowerAssessment>) => {
      const confirmed = await confirmIfSheetsConnected({
        title: 'Update Borrower Assessment in Google Sheets?',
        description:
          'This will update the borrower record in the Borrower_Assessments sheet.',
        affectedTarget: assessmentId,
        confirmLabel: 'Update Record',
      });
      if (!confirmed) return null;

      dispatch({ type: 'MUTATION_START' });
      try {
        const { assessment } = await apiClient.updateAssessment(
          assessmentId,
          payload
        );
        dispatch({ type: 'UPSERT_ASSESSMENT', assessment });
        notify('success', `Updated ${assessment.referenceCode}.`);
        return assessment;
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to update assessment.'
        );
        return null;
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [confirmIfSheetsConnected, notify]
  );

  const deleteAssessment = useCallback(
    async (assessmentId: string) => {
      const confirmed = await confirmIfSheetsConnected({
        title: 'Delete Assessment from Google Sheets?',
        description:
          'This will permanently remove the borrower assessment row from the Borrower_Assessments sheet.',
        affectedTarget: assessmentId,
        confirmLabel: 'Delete Assessment',
        isDestructive: true,
      });
      if (!confirmed) return;

      dispatch({ type: 'MUTATION_START' });
      try {
        await apiClient.deleteAssessment(assessmentId);
        dispatch({ type: 'REMOVE_ASSESSMENT', assessmentId });
        notify('info', 'Borrower assessment record removed.');
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to delete assessment.'
        );
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [confirmIfSheetsConnected, notify]
  );

  const evaluateAssessment = useCallback(
    async (
      assessmentId: string,
      datasetMode: 'official_catalog' | 'fictional_demo_sandbox'
    ) => {
      const confirmed = await confirmIfSheetsConnected({
        title: 'Run Two-Stage Matching & Log to Google Sheets?',
        description:
          'This will pull the latest verified Product Master from Google Sheets, execute Stage 1 & Stage 2 matching, and record the evaluation snapshot in Matching_Results.',
        affectedTarget: `${state.workspaceConfig.spreadsheetTitle} (Matching_Results)`,
        confirmLabel: 'Run & Record Match',
      });
      if (!confirmed) return;

      dispatch({ type: 'MUTATION_START' });
      try {
        const { assessment, categories } = await apiClient.evaluateAssessment(
          assessmentId,
          datasetMode
        );
        if (categories) {
          dispatch({
            type: 'SYNC_CATALOG',
            categories,
            fictionalDemoCategories: state.fictionalDemoCategories,
          });
        }
        dispatch({ type: 'UPSERT_ASSESSMENT', assessment });
        notify('success', 'Completed Two-Stage Requirement & Eligibility Matching.');
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Product matching evaluation failed.'
        );
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [
      confirmIfSheetsConnected,
      notify,
      state.fictionalDemoCategories,
      state.workspaceConfig.spreadsheetTitle,
    ]
  );

  const generateAiExplanation = useCallback(
    async (assessmentId: string) => {
      dispatch({ type: 'AI_START' });
      try {
        const { assessment } = await apiClient.generateAiExplanation(assessmentId);
        dispatch({ type: 'UPSERT_ASSESSMENT', assessment });
        notify('success', 'Generated separated AI advisory explanation.');
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to generate AI explanation.'
        );
      } finally {
        dispatch({ type: 'AI_END' });
      }
    },
    [notify]
  );

  const saveCategory = useCallback(
    async (categoryId: string, payload: Partial<ProductCategory>) => {
      const confirmed = await confirmIfSheetsConnected({
        title: 'Update Product Category in Google Sheets?',
        description:
          'This will update the category record and its rules in Product_Categories and Eligibility_Rules tabs, and log the change in Policy_Review_Log.',
        affectedTarget: `${payload.code || categoryId} -> Product_Categories`,
        confirmLabel: 'Save to Google Sheets',
      });
      if (!confirmed) return;

      dispatch({ type: 'MUTATION_START' });
      try {
        const { category, fictionalDemoCategories, policyLogs } =
          await apiClient.updateCategory(categoryId, payload);
        dispatch({
          type: 'UPSERT_CATEGORY',
          category,
          fictionalDemoCategories,
          policyLogs,
        });
        notify('success', `Saved configuration for ${category.code}.`);
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to save category.'
        );
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [confirmIfSheetsConnected, notify]
  );

  const addCategorySlot = useCallback(
    async (payload: Partial<ProductCategory>) => {
      const confirmed = await confirmIfSheetsConnected({
        title: 'Add Category Slot in Google Sheets?',
        description: 'This will append a new category row to Product_Categories.',
        affectedTarget: 'Product_Categories',
        confirmLabel: 'Add Slot',
      });
      if (!confirmed) return;

      dispatch({ type: 'MUTATION_START' });
      try {
        const { category } = await apiClient.createCategory(payload);
        dispatch({ type: 'UPSERT_CATEGORY', category });
        dispatch({ type: 'SET_ADMIN_CATEGORY', categoryId: category.id });
        notify('success', `Created category slot ${category.code}.`);
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Unable to add category slot.'
        );
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [confirmIfSheetsConnected, notify]
  );

  const addSubProduct = useCallback(
    async (categoryId: string, payload: Partial<SubProduct>) => {
      const confirmed = await confirmIfSheetsConnected({
        title: 'Create Sub-Product in Google Sheets?',
        description: 'This will add a new sub-product record to the Sub_Products tab.',
        affectedTarget: `${categoryId} -> Sub_Products`,
        confirmLabel: 'Create Sub-Product',
      });
      if (!confirmed) return null;

      dispatch({ type: 'MUTATION_START' });
      try {
        const { category, subProduct, fictionalDemoCategories } =
          await apiClient.createSubProduct(categoryId, payload);
        dispatch({
          type: 'UPSERT_CATEGORY',
          category,
          fictionalDemoCategories,
        });
        notify('success', `Added sub-product ${subProduct.code}.`);
        return subProduct;
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to add sub-product.'
        );
        return null;
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [confirmIfSheetsConnected, notify]
  );

  const saveSubProduct = useCallback(
    async (
      categoryId: string,
      subProductId: string,
      payload: Partial<SubProduct>
    ) => {
      const confirmed = await confirmIfSheetsConnected({
        title: 'Update Sub-Product & Rules in Google Sheets?',
        description:
          'This will update the sub-product specification and eligibility rules in Sub_Products and Eligibility_Rules tabs.',
        affectedTarget: `${payload.code || subProductId} -> Sub_Products`,
        confirmLabel: 'Save Sub-Product',
      });
      if (!confirmed) return;

      dispatch({ type: 'MUTATION_START' });
      try {
        const { category, subProduct, fictionalDemoCategories, policyLogs } =
          await apiClient.updateSubProduct(categoryId, subProductId, payload);
        dispatch({
          type: 'UPSERT_CATEGORY',
          category,
          fictionalDemoCategories,
          policyLogs,
        });
        notify('success', `Saved sub-product ${subProduct.code}.`);
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to update sub-product.'
        );
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [confirmIfSheetsConnected, notify]
  );

  const removeSubProduct = useCallback(
    async (categoryId: string, subProductId: string) => {
      const confirmed = await confirmIfSheetsConnected({
        title: 'Delete Sub-Product from Google Sheets?',
        description:
          'This will permanently remove the sub-product and its rules from Sub_Products and Eligibility_Rules tabs.',
        affectedTarget: subProductId,
        confirmLabel: 'Delete Sub-Product',
        isDestructive: true,
      });
      if (!confirmed) return;

      dispatch({ type: 'MUTATION_START' });
      try {
        const { category, fictionalDemoCategories } =
          await apiClient.deleteSubProduct(categoryId, subProductId);
        dispatch({
          type: 'UPSERT_CATEGORY',
          category,
          fictionalDemoCategories,
        });
        notify('info', 'Sub-product deleted from category.');
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to delete sub-product.'
        );
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [confirmIfSheetsConnected, notify]
  );

  const importCatalogConfig = useCallback(
    async (categories: ProductCategory[]) => {
      const confirmed = await confirmIfSheetsConnected({
        title: 'Overwrite Product Catalog in Google Sheets?',
        description: `This will replace ${categories.length} category records and their sub-products in your connected Google Spreadsheet.`,
        affectedTarget: `${state.workspaceConfig.spreadsheetTitle} (Product_Categories & Sub_Products)`,
        confirmLabel: 'Import & Sync',
        isDestructive: true,
      });
      if (!confirmed) return false;

      dispatch({ type: 'MUTATION_START' });
      try {
        const res = await apiClient.importCatalog(categories);
        dispatch({
          type: 'SYNC_CATALOG',
          categories: res.categories,
          fictionalDemoCategories: res.fictionalDemoCategories,
        });
        notify(
          'success',
          `Imported ${res.categories.length} product categories.`
        );
        return true;
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Catalog JSON import failed.'
        );
        return false;
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [
      confirmIfSheetsConnected,
      notify,
      state.workspaceConfig.spreadsheetTitle,
    ]
  );

  const resetCatalogPlaceholders = useCallback(async () => {
    const confirmed = await confirmIfSheetsConnected({
      title: 'Reset All 19 Slots to Empty Placeholders in Google Sheets?',
      description:
        'This will clear configured categories, sub-products, and rules in Google Sheets back to 19 blank category placeholders.',
      affectedTarget: `${state.workspaceConfig.spreadsheetTitle} (All 19 Category Slots)`,
      confirmLabel: 'Reset 19 Slots',
      isDestructive: true,
    });
    if (!confirmed) return;

    dispatch({ type: 'MUTATION_START' });
    try {
      const res = await apiClient.resetCatalogPlaceholders();
      dispatch({
        type: 'SYNC_CATALOG',
        categories: res.categories,
        fictionalDemoCategories: res.fictionalDemoCategories,
      });
      notify('info', 'Reset all 19 main categories to clean empty placeholders.');
    } catch (err) {
      notify(
        'error',
        err instanceof Error ? err.message : 'Failed to reset placeholders.'
      );
    } finally {
      dispatch({ type: 'MUTATION_END' });
    }
  }, [
    confirmIfSheetsConnected,
    notify,
    state.workspaceConfig.spreadsheetTitle,
  ]);

  const resetDemoAssessments = useCallback(async () => {
    const confirmed = await confirmIfSheetsConnected({
      title: 'Restore Fictional Demo Assessments in Google Sheets?',
      description:
        'This will restore the clearly labeled [FICTIONAL DEMO] sample assessments in Borrower_Assessments while preserving employee entries.',
      affectedTarget: 'Borrower_Assessments',
      confirmLabel: 'Restore Demo Cases',
    });
    if (!confirmed) return;

    dispatch({ type: 'MUTATION_START' });
    try {
      const { assessments } = await apiClient.resetDemoAssessments();
      dispatch({ type: 'SET_ASSESSMENTS', assessments });
      notify('info', 'Restored default fictional demo borrower assessments.');
    } catch (err) {
      notify(
        'error',
        err instanceof Error ? err.message : 'Failed to restore demo records.'
      );
    } finally {
      dispatch({ type: 'MUTATION_END' });
    }
  }, [confirmIfSheetsConnected, notify]);

  const saveSettings = useCallback(
    async (payload: Partial<SystemSettings>) => {
      dispatch({ type: 'MUTATION_START' });
      try {
        const { settings } = await apiClient.updateSettings(payload);
        dispatch({ type: 'SET_SETTINGS', settings });
        notify('success', 'System settings updated.');
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? err.message : 'Failed to update settings.'
        );
      } finally {
        dispatch({ type: 'MUTATION_END' });
      }
    },
    [notify]
  );

  return (
    <AppStateContext.Provider
      value={{
        state,
        refreshBootstrap,
        requestWorkspaceConfirmation,
        createMasterSheet,
        connectExistingSheet,
        syncGoogleSheetsNow,
        applyWorkspaceImportResult,
        createStudyMaterialFolder,
        updateAccessControl,
        uploadPdfToDrive,
        linkExistingDrivePdf,
        extractPdfDraftWithAi,
        verifyRuleDecision,
        verifyAllDraftRules,
        navigateTo,
        openAdminTab,
        openAssessmentInEngine,
        openCategoryInAdmin,
        setCatalogViewMode,
        setSelectedAssessmentId,
        setSelectedAdminCategoryId,
        signInLocalUser,
        signUpLocalUser,
        signOut,
        notify,
        clearToast,
        createAssessment,
        updateAssessment,
        deleteAssessment,
        evaluateAssessment,
        generateAiExplanation,
        saveCategory,
        addCategorySlot,
        addSubProduct,
        saveSubProduct,
        removeSubProduct,
        importCatalogConfig,
        resetCatalogPlaceholders,
        resetDemoAssessments,
        saveSettings,
      }}
    >
      {children}
      <WorkspaceConfirmModal
        request={confirmReq}
        onConfirm={() => handleConfirmResolve(true)}
        onCancel={() => handleConfirmResolve(false)}
      />
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error('useAppState must be used within AppStateProvider.');
  }
  return ctx;
}
