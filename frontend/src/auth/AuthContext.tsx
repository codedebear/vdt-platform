/**
 * Authentication state for the SPA.
 *
 * Persists the JWT + user in localStorage so a refresh keeps the session, wires
 * the API client to read the current token, and exposes login/register/logout.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, configureApi } from '../lib/api';
import type { AuthResponse, User } from '../lib/types';

const STORAGE_KEY = 'vdt.auth';

interface StoredAuth {
  token: string;
  user: User;
}

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function loadStored(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    if (parsed?.token && parsed?.user) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<StoredAuth | null>(() => loadStored());

  // Keep a ref to the latest token so the API client's getter is always current
  // without re-running configureApi on every token change.
  const tokenRef = useRef<string | null>(auth?.token ?? null);
  tokenRef.current = auth?.token ?? null;

  const logout = useCallback(() => {
    setAuth(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  // Configure the API client once: it reads the live token and logs out on 401.
  useEffect(() => {
    configureApi({
      getToken: () => tokenRef.current,
      onUnauthorized: () => logout(),
    });
  }, [logout]);

  const persist = useCallback((res: AuthResponse) => {
    const next: StoredAuth = { token: res.token, user: res.user };
    setAuth(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      persist(await api.login(email, password));
    },
    [persist],
  );

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      persist(await api.register(name, email, password));
    },
    [persist],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user: auth?.user ?? null,
      token: auth?.token ?? null,
      isAuthenticated: Boolean(auth?.token),
      login,
      register,
      logout,
    }),
    [auth, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Access the auth context; throws if used outside the provider. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
