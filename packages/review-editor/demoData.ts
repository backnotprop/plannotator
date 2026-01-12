/**
 * Demo diff data for development mode
 */

export const DEMO_DIFF = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index 1234567..abcdefg 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,10 +1,15 @@
-import React from 'react';
+import React, { useCallback } from 'react';

 interface ButtonProps {
   label: string;
   onClick: () => void;
+  disabled?: boolean;
+  variant?: 'primary' | 'secondary';
 }

-export const Button = ({ label, onClick }: ButtonProps) => {
+export const Button = ({ label, onClick, disabled, variant = 'primary' }: ButtonProps) => {
+  const handleClick = useCallback(() => {
+    if (!disabled) onClick();
+  }, [disabled, onClick]);
+
   return (
-    <button onClick={onClick}>
+    <button onClick={handleClick} disabled={disabled} className={variant}>
       {label}
     </button>
   );
diff --git a/src/utils/helpers.ts b/src/utils/helpers.ts
index 2345678..bcdefgh 100644
--- a/src/utils/helpers.ts
+++ b/src/utils/helpers.ts
@@ -5,3 +5,8 @@ export function formatDate(date: Date): string {
 export function capitalize(str: string): string {
   return str.charAt(0).toUpperCase() + str.slice(1);
 }
+
+export function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
+  let timeoutId: NodeJS.Timeout;
+  return ((...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn(...args), delay); }) as T;
+}
diff --git a/src/hooks/useAuth.ts b/src/hooks/useAuth.ts
index 3456789..cdefghi 100644
--- a/src/hooks/useAuth.ts
+++ b/src/hooks/useAuth.ts
@@ -1,25 +1,58 @@
-import { useState } from 'react';
+import { useState, useEffect, useCallback } from 'react';
+import { api } from '../services/api';

 interface User {
   id: string;
-  name: string;
+  username: string;
   email: string;
+  role: 'admin' | 'user' | 'guest';
+  createdAt: Date;
 }

 interface AuthState {
   user: User | null;
   isLoading: boolean;
+  error: string | null;
 }

-export function useAuth() {
-  const [state, setState] = useState<AuthState>({
+interface AuthActions {
+  login: (email: string, password: string) => Promise<void>;
+  logout: () => Promise<void>;
+  refresh: () => Promise<void>;
+}
+
+export function useAuth(): AuthState & AuthActions {
+  const [state, setState] = useState<AuthState>({
     user: null,
     isLoading: true,
+    error: null,
   });

-  const login = async (email: string, password: string) => {
-    // TODO: Implement login
+  const login = useCallback(async (email: string, password: string) => {
+    setState(prev => ({ ...prev, isLoading: true, error: null }));
+    try {
+      const user = await api.auth.login(email, password);
+      setState({ user, isLoading: false, error: null });
+    } catch (err) {
+      setState(prev => ({
+        ...prev,
+        isLoading: false,
+        error: err instanceof Error ? err.message : 'Login failed',
+      }));
+    }
+  }, []);
+
+  const logout = useCallback(async () => {
+    await api.auth.logout();
+    setState({ user: null, isLoading: false, error: null });
+  }, []);
+
+  const refresh = useCallback(async () => {
+    try {
+      const user = await api.auth.refresh();
+      setState({ user, isLoading: false, error: null });
+    } catch {
+      setState({ user: null, isLoading: false, error: null });
+    }
+  }, []);
+
+  useEffect(() => {
+    refresh();
+  }, [refresh]);

-  return { ...state, login };
+  return { ...state, login, logout, refresh };
 }
diff --git a/src/services/api.ts b/src/services/api.ts
index 4567890..defghij 100644
--- a/src/services/api.ts
+++ b/src/services/api.ts
@@ -1,15 +1,72 @@
-const BASE_URL = '/api';
+const BASE_URL = process.env.API_URL || '/api';
+
+interface RequestOptions {
+  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
+  body?: unknown;
+  headers?: Record<string, string>;
+}
+
+class ApiError extends Error {
+  constructor(
+    message: string,
+    public status: number,
+    public code?: string
+  ) {
+    super(message);
+    this.name = 'ApiError';
+  }
+}

-async function request(endpoint: string, options?: RequestInit) {
-  const response = await fetch(\`\${BASE_URL}\${endpoint}\`, options);
-  return response.json();
+async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
+  const { method = 'GET', body, headers = {} } = options;
+
+  const config: RequestInit = {
+    method,
+    headers: {
+      'Content-Type': 'application/json',
+      ...headers,
+    },
+    credentials: 'include',
+  };
+
+  if (body) {
+    config.body = JSON.stringify(body);
+  }
+
+  const response = await fetch(\`\${BASE_URL}\${endpoint}\`, config);
+
+  if (!response.ok) {
+    const error = await response.json().catch(() => ({}));
+    throw new ApiError(
+      error.message || 'Request failed',
+      response.status,
+      error.code
+    );
+  }
+
+  return response.json();
 }

 export const api = {
-  users: {
-    list: () => request('/users'),
-    get: (id: string) => request(\`/users/\${id}\`),
+  auth: {
+    login: (email: string, password: string) =>
+      request('/auth/login', { method: 'POST', body: { email, password } }),
+    logout: () => request('/auth/logout', { method: 'POST' }),
+    refresh: () => request('/auth/refresh', { method: 'POST' }),
+  },
+  users: {
+    list: (params?: { page?: number; limit?: number }) =>
+      request(\`/users?\${new URLSearchParams(params as Record<string, string>)}\`),
+    get: (id: string) => request(\`/users/\${id}\`),
+    create: (data: { email: string; username: string }) =>
+      request('/users', { method: 'POST', body: data }),
+    update: (id: string, data: Partial<{ email: string; username: string }>) =>
+      request(\`/users/\${id}\`, { method: 'PATCH', body: data }),
+    delete: (id: string) => request(\`/users/\${id}\`, { method: 'DELETE' }),
   },
 };
diff --git a/src/components/Modal.tsx b/src/components/Modal.tsx
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/components/Modal.tsx
@@ -0,0 +1,48 @@
+import React, { useEffect, useCallback } from 'react';
+import { createPortal } from 'react-dom';
+
+interface ModalProps {
+  isOpen: boolean;
+  onClose: () => void;
+  title?: string;
+  children: React.ReactNode;
+}
+
+export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children }) => {
+  const handleEscape = useCallback((e: KeyboardEvent) => {
+    if (e.key === 'Escape') onClose();
+  }, [onClose]);
+
+  useEffect(() => {
+    if (isOpen) {
+      document.addEventListener('keydown', handleEscape);
+      document.body.style.overflow = 'hidden';
+    }
+    return () => {
+      document.removeEventListener('keydown', handleEscape);
+      document.body.style.overflow = '';
+    };
+  }, [isOpen, handleEscape]);
+
+  if (!isOpen) return null;
+
+  return createPortal(
+    <div className="modal-overlay" onClick={onClose}>
+      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
+        {title && (
+          <div className="modal-header">
+            <h2>{title}</h2>
+            <button className="modal-close" onClick={onClose}>
+              ×
+            </button>
+          </div>
+        )}
+        <div className="modal-body">{children}</div>
+      </div>
+    </div>,
+    document.body
+  );
+};
`;
