#!/bin/bash
# Sandbox script for testing Plannotator OpenCode plugin locally
#
# Usage:
#   ./sandbox-opencode.sh [--disable-sharing] [--keep] [--no-git]
#
# Options:
#   --disable-sharing  Create opencode.json with "share": "disabled" to test
#                      the sharing disable feature without env var pollution
#   --keep             Don't clean up sandbox on exit (for debugging)
#   --no-git           Don't initialize git repo (tests non-git fallback)
#
# What it does:
#   1. Builds the plugin (ensures latest code)
#   2. Creates a temp directory with git repo
#   3. Creates sample files with uncommitted changes (for /plannotator-review)
#   4. Sets up the local plugin
#   5. Launches OpenCode in the sandbox
#
# To test:
#   - Plan mode: Ask the agent to plan something, it should call submit_plan
#   - Code review: Run /plannotator-review to review the sample changes

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PLUGIN_DIR="$PROJECT_ROOT/apps/opencode-plugin"

# Parse CLI flags
DISABLE_SHARING=false
KEEP_SANDBOX=false
NO_GIT=false
for arg in "$@"; do
  case $arg in
    --disable-sharing)
      DISABLE_SHARING=true
      shift
      ;;
    --keep)
      KEEP_SANDBOX=true
      shift
      ;;
    --no-git)
      NO_GIT=true
      shift
      ;;
  esac
done

echo "=== Plannotator OpenCode Sandbox ==="
echo ""

# Build the plugin (includes building dependencies)
echo "Building plugin..."
cd "$PROJECT_ROOT"
bun run build:review > /dev/null 2>&1  # Required for opencode build
bun run build:opencode
echo ""

# Create temp directory
SANDBOX_DIR=$(mktemp -d)
echo "Created sandbox: $SANDBOX_DIR"

# Cleanup on exit (unless --keep)
cleanup() {
  echo ""
  if [ "$KEEP_SANDBOX" = true ]; then
    echo "Keeping sandbox at: $SANDBOX_DIR"
    echo "To clean up manually: rm -rf $SANDBOX_DIR"
  else
    echo "Cleaning up sandbox..."
    rm -rf "$SANDBOX_DIR"
    echo "Done."
  fi
}
trap cleanup EXIT

# Initialize git repo (unless --no-git)
cd "$SANDBOX_DIR"
if [ "$NO_GIT" = false ]; then
  git init -q
  git config user.email "test@example.com"
  git config user.name "Test User"
fi

# Create initial project structure
mkdir -p src/{api,components,hooks,utils,types}
mkdir -p tests

cat > package.json << 'EOF'
{
  "name": "task-manager-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vite": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
EOF

cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
EOF

# Types
cat > src/types/index.ts << 'EOF'
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  assigneeId: string;
  dueDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiResponse<T> {
  data: T;
  error?: string;
  status: number;
}
EOF

# API client
cat > src/api/client.ts << 'EOF'
const API_BASE = 'https://api.example.com';

export async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}
EOF

# Task API
cat > src/api/tasks.ts << 'EOF'
import { fetchApi } from './client';
import type { Task, ApiResponse } from '../types';

export async function getTasks(): Promise<Task[]> {
  const response = await fetchApi<ApiResponse<Task[]>>('/tasks');
  return response.data;
}

export async function getTask(id: string): Promise<Task> {
  const response = await fetchApi<ApiResponse<Task>>(`/tasks/${id}`);
  return response.data;
}

export async function createTask(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<Task> {
  const response = await fetchApi<ApiResponse<Task>>('/tasks', {
    method: 'POST',
    body: JSON.stringify(task),
  });
  return response.data;
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task> {
  const response = await fetchApi<ApiResponse<Task>>(`/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  return response.data;
}

export async function deleteTask(id: string): Promise<void> {
  await fetchApi(`/tasks/${id}`, { method: 'DELETE' });
}
EOF

# User API
cat > src/api/users.ts << 'EOF'
import { fetchApi } from './client';
import type { User, ApiResponse } from '../types';

export async function getUsers(): Promise<User[]> {
  const response = await fetchApi<ApiResponse<User[]>>('/users');
  return response.data;
}

export async function getUser(id: string): Promise<User> {
  const response = await fetchApi<ApiResponse<User>>(`/users/${id}`);
  return response.data;
}

export async function getCurrentUser(): Promise<User> {
  const response = await fetchApi<ApiResponse<User>>('/users/me');
  return response.data;
}
EOF

# Utils
cat > src/utils/formatters.ts << 'EOF'
export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
EOF

cat > src/utils/validators.ts << 'EOF'
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function isValidTaskTitle(title: string): boolean {
  return title.length >= 3 && title.length <= 100;
}

export function isValidTaskDescription(description: string): boolean {
  return description.length <= 500;
}
EOF

# Hooks
cat > src/hooks/useTasks.ts << 'EOF'
import { useState, useEffect, useCallback } from 'react';
import { getTasks, createTask, updateTask, deleteTask } from '../api/tasks';
import type { Task } from '../types';

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getTasks();
      setTasks(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const addTask = useCallback(async (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newTask = await createTask(task);
    setTasks(prev => [...prev, newTask]);
    return newTask;
  }, []);

  const editTask = useCallback(async (id: string, updates: Partial<Task>) => {
    const updated = await updateTask(id, updates);
    setTasks(prev => prev.map(t => t.id === id ? updated : t));
    return updated;
  }, []);

  const removeTask = useCallback(async (id: string) => {
    await deleteTask(id);
    setTasks(prev => prev.filter(t => t.id !== id));
  }, []);

  return { tasks, loading, error, fetchTasks, addTask, editTask, removeTask };
}
EOF

cat > src/hooks/useAuth.ts << 'EOF'
import { useState, useEffect, useCallback } from 'react';
import { getCurrentUser } from '../api/users';
import type { User } from '../types';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCurrentUser()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    localStorage.removeItem('auth_token');
  }, []);

  return { user, loading, logout, isAuthenticated: !!user };
}
EOF

# Components
cat > src/components/TaskCard.tsx << 'EOF'
import React from 'react';
import type { Task } from '../types';
import { formatRelativeTime } from '../utils/formatters';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
}

export function TaskCard({ task, onEdit, onDelete }: TaskCardProps) {
  const statusColors = {
    pending: 'bg-yellow-100 text-yellow-800',
    in_progress: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
  };

  return (
    <div className="border rounded-lg p-4 shadow-sm">
      <div className="flex justify-between items-start">
        <h3 className="font-semibold text-lg">{task.title}</h3>
        <span className={`px-2 py-1 rounded text-sm ${statusColors[task.status]}`}>
          {task.status.replace('_', ' ')}
        </span>
      </div>
      <p className="text-gray-600 mt-2">{task.description}</p>
      <div className="flex justify-between items-center mt-4 text-sm text-gray-500">
        <span>Updated {formatRelativeTime(task.updatedAt)}</span>
        <div className="space-x-2">
          <button onClick={() => onEdit(task)} className="text-blue-600 hover:underline">
            Edit
          </button>
          <button onClick={() => onDelete(task.id)} className="text-red-600 hover:underline">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
EOF

cat > src/components/TaskList.tsx << 'EOF'
import React from 'react';
import { TaskCard } from './TaskCard';
import type { Task } from '../types';

interface TaskListProps {
  tasks: Task[];
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
  loading?: boolean;
}

export function TaskList({ tasks, onEdit, onDelete, loading }: TaskListProps) {
  if (loading) {
    return <div className="text-center py-8">Loading tasks...</div>;
  }

  if (tasks.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No tasks yet. Create one to get started!
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {tasks.map(task => (
        <TaskCard
          key={task.id}
          task={task}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
EOF

cat > src/components/TaskForm.tsx << 'EOF'
import React, { useState } from 'react';
import type { Task } from '../types';
import { isValidTaskTitle, isValidTaskDescription } from '../utils/validators';

interface TaskFormProps {
  initialData?: Partial<Task>;
  onSubmit: (data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onCancel: () => void;
}

export function TaskForm({ initialData, onSubmit, onCancel }: TaskFormProps) {
  const [title, setTitle] = useState(initialData?.title || '');
  const [description, setDescription] = useState(initialData?.description || '');
  const [status, setStatus] = useState<Task['status']>(initialData?.status || 'pending');
  const [errors, setErrors] = useState<{ title?: string; description?: string }>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const newErrors: { title?: string; description?: string } = {};

    if (!isValidTaskTitle(title)) {
      newErrors.title = 'Title must be between 3 and 100 characters';
    }

    if (!isValidTaskDescription(description)) {
      newErrors.description = 'Description must be less than 500 characters';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    onSubmit({
      title,
      description,
      status,
      assigneeId: initialData?.assigneeId || '',
      dueDate: initialData?.dueDate || new Date(),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="w-full border rounded px-3 py-2"
        />
        {errors.title && <p className="text-red-500 text-sm mt-1">{errors.title}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Description</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="w-full border rounded px-3 py-2"
          rows={3}
        />
        {errors.description && <p className="text-red-500 text-sm mt-1">{errors.description}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Status</label>
        <select
          value={status}
          onChange={e => setStatus(e.target.value as Task['status'])}
          className="w-full border rounded px-3 py-2"
        >
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
        </select>
      </div>

      <div className="flex justify-end space-x-2">
        <button type="button" onClick={onCancel} className="px-4 py-2 border rounded">
          Cancel
        </button>
        <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded">
          {initialData ? 'Update' : 'Create'}
        </button>
      </div>
    </form>
  );
}
EOF

# Main App
cat > src/App.tsx << 'EOF'
import React, { useState } from 'react';
import { TaskList } from './components/TaskList';
import { TaskForm } from './components/TaskForm';
import { useTasks } from './hooks/useTasks';
import { useAuth } from './hooks/useAuth';
import type { Task } from './types';

export function App() {
  const { user, loading: authLoading, logout } = useAuth();
  const { tasks, loading, error, addTask, editTask, removeTask } = useTasks();
  const [showForm, setShowForm] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  if (authLoading) {
    return <div className="flex items-center justify-center h-screen">Loading...</div>;
  }

  const handleSubmit = async (data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (editingTask) {
      await editTask(editingTask.id, data);
    } else {
      await addTask(data);
    }
    setShowForm(false);
    setEditingTask(null);
  };

  const handleEdit = (task: Task) => {
    setEditingTask(task);
    setShowForm(true);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-4xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-xl font-bold">Task Manager</h1>
          {user && (
            <div className="flex items-center space-x-4">
              <span>{user.name}</span>
              <button onClick={logout} className="text-gray-600 hover:text-gray-800">
                Logout
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {error && (
          <div className="bg-red-100 text-red-700 p-4 rounded mb-4">
            {error}
          </div>
        )}

        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-semibold">Your Tasks</h2>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            New Task
          </button>
        </div>

        {showForm ? (
          <div className="bg-white p-6 rounded-lg shadow mb-6">
            <h3 className="text-lg font-semibold mb-4">
              {editingTask ? 'Edit Task' : 'Create Task'}
            </h3>
            <TaskForm
              initialData={editingTask || undefined}
              onSubmit={handleSubmit}
              onCancel={() => {
                setShowForm(false);
                setEditingTask(null);
              }}
            />
          </div>
        ) : null}

        <TaskList
          tasks={tasks}
          loading={loading}
          onEdit={handleEdit}
          onDelete={removeTask}
        />
      </main>
    </div>
  );
}

export default App;
EOF

# Tests
cat > tests/formatters.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { formatDate, truncateText, formatRelativeTime } from '../src/utils/formatters';

describe('formatters', () => {
  describe('formatDate', () => {
    it('formats date correctly', () => {
      const date = new Date('2024-01-15');
      expect(formatDate(date)).toContain('January');
      expect(formatDate(date)).toContain('15');
      expect(formatDate(date)).toContain('2024');
    });
  });

  describe('truncateText', () => {
    it('returns original text if shorter than max length', () => {
      expect(truncateText('hello', 10)).toBe('hello');
    });

    it('truncates and adds ellipsis for long text', () => {
      expect(truncateText('hello world', 8)).toBe('hello...');
    });
  });

  describe('formatRelativeTime', () => {
    it('returns "just now" for recent times', () => {
      const now = new Date();
      expect(formatRelativeTime(now)).toBe('just now');
    });
  });
});
EOF

cat > tests/validators.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { isValidEmail, isValidTaskTitle, isValidTaskDescription } from '../src/utils/validators';

describe('validators', () => {
  describe('isValidEmail', () => {
    it('returns true for valid emails', () => {
      expect(isValidEmail('test@example.com')).toBe(true);
      expect(isValidEmail('user.name@domain.org')).toBe(true);
    });

    it('returns false for invalid emails', () => {
      expect(isValidEmail('invalid')).toBe(false);
      expect(isValidEmail('test@')).toBe(false);
      expect(isValidEmail('@domain.com')).toBe(false);
    });
  });

  describe('isValidTaskTitle', () => {
    it('returns true for valid titles', () => {
      expect(isValidTaskTitle('Valid task title')).toBe(true);
    });

    it('returns false for too short titles', () => {
      expect(isValidTaskTitle('ab')).toBe(false);
    });

    it('returns false for too long titles', () => {
      expect(isValidTaskTitle('a'.repeat(101))).toBe(false);
    });
  });
});
EOF

# Create .opencode package.json for plugin dependencies
mkdir -p .opencode
cat > .opencode/package.json << 'EOF'
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.0.218"
  }
}
EOF

if [ "$NO_GIT" = false ]; then
  git add .
  git commit -q -m "Initial commit: Task manager app"
fi

# =============================================================================
# Make uncommitted changes (simulating a feature branch with multiple changes)
# =============================================================================

# 1. API client - add retry logic and better error handling
cat > src/api/client.ts << 'EOF'
const API_BASE = process.env.API_URL || 'https://api.example.com';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

interface ApiError {
  message: string;
  code: string;
  status: number;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {},
  retries = MAX_RETRIES
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': crypto.randomUUID(),
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({})) as Partial<ApiError>;
      throw new ApiClientError(
        errorBody.message || `API error: ${response.status}`,
        response.status,
        errorBody.code || 'UNKNOWN_ERROR'
      );
    }

    return response.json();
  } catch (error) {
    if (error instanceof ApiClientError) {
      // Don't retry client errors (4xx)
      if (error.status >= 400 && error.status < 500) {
        throw error;
      }
    }

    // Retry on network errors or 5xx
    if (retries > 0) {
      await delay(RETRY_DELAY);
      return fetchApi(url, options, retries - 1);
    }

    throw error;
  }
}

// New: Batch request support
export async function fetchApiBatch<T>(
  requests: Array<{ endpoint: string; options?: RequestInit }>
): Promise<T[]> {
  return Promise.all(
    requests.map(({ endpoint, options }) => fetchApi<T>(endpoint, options))
  );
}
EOF

# 2. Tasks API - add filtering, sorting, and pagination
cat > src/api/tasks.ts << 'EOF'
import { fetchApi, fetchApiBatch } from './client';
import type { Task, ApiResponse } from '../types';

export interface TaskFilters {
  status?: Task['status'];
  assigneeId?: string;
  dueBefore?: Date;
  dueAfter?: Date;
  search?: string;
}

export interface TaskSortOptions {
  field: 'title' | 'dueDate' | 'createdAt' | 'updatedAt';
  direction: 'asc' | 'desc';
}

export interface PaginationOptions {
  page: number;
  limit: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  totalPages: number;
}

function buildQueryString(params: Record<string, string | number | undefined>): string {
  const filtered = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return filtered.length > 0 ? `?${filtered.join('&')}` : '';
}

export async function getTasks(
  filters?: TaskFilters,
  sort?: TaskSortOptions,
  pagination?: PaginationOptions
): Promise<PaginatedResponse<Task>> {
  const query = buildQueryString({
    status: filters?.status,
    assigneeId: filters?.assigneeId,
    dueBefore: filters?.dueBefore?.toISOString(),
    dueAfter: filters?.dueAfter?.toISOString(),
    search: filters?.search,
    sortBy: sort?.field,
    sortDir: sort?.direction,
    page: pagination?.page,
    limit: pagination?.limit,
  });

  const response = await fetchApi<ApiResponse<PaginatedResponse<Task>>>(`/tasks${query}`);
  return response.data;
}

export async function getTask(id: string): Promise<Task> {
  const response = await fetchApi<ApiResponse<Task>>(`/tasks/${id}`);
  return response.data;
}

export async function getTasksByIds(ids: string[]): Promise<Task[]> {
  if (ids.length === 0) return [];

  // Use batch API for efficiency
  const requests = ids.map(id => ({ endpoint: `/tasks/${id}` }));
  const responses = await fetchApiBatch<ApiResponse<Task>>(requests);
  return responses.map(r => r.data);
}

export async function createTask(
  task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Task> {
  const response = await fetchApi<ApiResponse<Task>>('/tasks', {
    method: 'POST',
    body: JSON.stringify(task),
  });
  return response.data;
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task> {
  const response = await fetchApi<ApiResponse<Task>>(`/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  return response.data;
}

export async function bulkUpdateTasks(
  updates: Array<{ id: string; changes: Partial<Task> }>
): Promise<Task[]> {
  const response = await fetchApi<ApiResponse<Task[]>>('/tasks/bulk', {
    method: 'PATCH',
    body: JSON.stringify({ updates }),
  });
  return response.data;
}

export async function deleteTask(id: string): Promise<void> {
  await fetchApi(`/tasks/${id}`, { method: 'DELETE' });
}

export async function bulkDeleteTasks(ids: string[]): Promise<void> {
  await fetchApi('/tasks/bulk', {
    method: 'DELETE',
    body: JSON.stringify({ ids }),
  });
}
EOF

# 3. Add new types
cat > src/types/index.ts << 'EOF'
export interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  role: 'admin' | 'member' | 'viewer';
  createdAt: Date;
  updatedAt: Date;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assigneeId: string;
  assignee?: User;
  labels: string[];
  dueDate: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiResponse<T> {
  data: T;
  error?: ApiError;
  status: number;
  requestId: string;
}

export interface ApiError {
  message: string;
  code: string;
  details?: Record<string, string[]>;
}

export interface Notification {
  id: string;
  type: 'task_assigned' | 'task_completed' | 'comment_added' | 'due_date_reminder';
  taskId: string;
  message: string;
  read: boolean;
  createdAt: Date;
}

// Utility types
export type TaskStatus = Task['status'];
export type TaskPriority = Task['priority'];
export type UserRole = User['role'];
EOF

# 4. Update formatters with new functions
cat > src/utils/formatters.ts << 'EOF'
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) return `${months} month${months > 1 ? 's' : ''} ago`;
  if (weeks > 0) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

export function formatDueDate(date: Date | string): { text: string; isOverdue: boolean; isUrgent: boolean } {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));

  if (days < 0) {
    return { text: `${Math.abs(days)} day${Math.abs(days) > 1 ? 's' : ''} overdue`, isOverdue: true, isUrgent: true };
  }
  if (days === 0) {
    return { text: 'Due today', isOverdue: false, isUrgent: true };
  }
  if (days === 1) {
    return { text: 'Due tomorrow', isOverdue: false, isUrgent: true };
  }
  if (days <= 7) {
    return { text: `Due in ${days} days`, isOverdue: false, isUrgent: false };
  }
  return { text: formatDate(d), isOverdue: false, isUrgent: false };
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural || `${singular}s`);
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
EOF

# 5. Update TaskCard with priority badge and labels
cat > src/components/TaskCard.tsx << 'EOF'
import React, { useState } from 'react';
import type { Task } from '../types';
import { formatRelativeTime, formatDueDate, truncateText } from '../utils/formatters';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
  onStatusChange: (id: string, status: Task['status']) => void;
}

export function TaskCard({ task, onEdit, onDelete, onStatusChange }: TaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);

  const statusColors: Record<Task['status'], string> = {
    pending: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    in_progress: 'bg-blue-100 text-blue-800 border-blue-200',
    completed: 'bg-green-100 text-green-800 border-green-200',
    cancelled: 'bg-gray-100 text-gray-800 border-gray-200',
  };

  const priorityColors: Record<Task['priority'], string> = {
    low: 'bg-slate-100 text-slate-600',
    medium: 'bg-amber-100 text-amber-700',
    high: 'bg-orange-100 text-orange-700',
    urgent: 'bg-red-100 text-red-700',
  };

  const priorityIcons: Record<Task['priority'], string> = {
    low: '○',
    medium: '◐',
    high: '●',
    urgent: '⚠',
  };

  const dueInfo = formatDueDate(task.dueDate);

  const handleDelete = () => {
    if (showConfirmDelete) {
      onDelete(task.id);
    } else {
      setShowConfirmDelete(true);
      setTimeout(() => setShowConfirmDelete(false), 3000);
    }
  };

  const nextStatus: Record<Task['status'], Task['status']> = {
    pending: 'in_progress',
    in_progress: 'completed',
    completed: 'pending',
    cancelled: 'pending',
  };

  return (
    <div className={`border rounded-lg p-4 shadow-sm transition-all hover:shadow-md ${
      task.status === 'completed' ? 'opacity-75' : ''
    }`}>
      <div className="flex justify-between items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${priorityColors[task.priority]}`}>
              {priorityIcons[task.priority]} {task.priority}
            </span>
            <span className={`px-2 py-0.5 rounded text-xs border ${statusColors[task.status]}`}>
              {task.status.replace('_', ' ')}
            </span>
          </div>
          <h3 className={`font-semibold text-lg ${task.status === 'completed' ? 'line-through text-gray-500' : ''}`}>
            {task.title}
          </h3>
        </div>
        <button
          onClick={() => onStatusChange(task.id, nextStatus[task.status])}
          className="p-2 rounded-full hover:bg-gray-100 transition-colors"
          title={`Mark as ${nextStatus[task.status]}`}
        >
          {task.status === 'completed' ? '↩' : '✓'}
        </button>
      </div>

      <p className="text-gray-600 mt-2">
        {isExpanded ? task.description : truncateText(task.description, 120)}
        {task.description.length > 120 && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-blue-600 hover:underline ml-1 text-sm"
          >
            {isExpanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </p>

      {task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {task.labels.map(label => (
            <span key={label} className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs">
              {label}
            </span>
          ))}
        </div>
      )}

      <div className="flex justify-between items-center mt-4 pt-3 border-t text-sm">
        <div className="flex items-center gap-4 text-gray-500">
          <span className={dueInfo.isOverdue ? 'text-red-600 font-medium' : dueInfo.isUrgent ? 'text-orange-600' : ''}>
            {dueInfo.text}
          </span>
          <span>Updated {formatRelativeTime(task.updatedAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onEdit(task)}
            className="px-3 py-1 text-blue-600 hover:bg-blue-50 rounded transition-colors"
          >
            Edit
          </button>
          <button
            onClick={handleDelete}
            className={`px-3 py-1 rounded transition-colors ${
              showConfirmDelete
                ? 'bg-red-600 text-white'
                : 'text-red-600 hover:bg-red-50'
            }`}
          >
            {showConfirmDelete ? 'Confirm?' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
EOF

# 6. Update useTasks hook with filters and pagination
cat > src/hooks/useTasks.ts << 'EOF'
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  bulkUpdateTasks,
  bulkDeleteTasks,
  type TaskFilters,
  type TaskSortOptions,
  type PaginationOptions,
} from '../api/tasks';
import type { Task } from '../types';

interface UseTasksOptions {
  filters?: TaskFilters;
  sort?: TaskSortOptions;
  pagination?: PaginationOptions;
}

export function useTasks(options: UseTasksOptions = {}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { filters, sort, pagination } = options;

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await getTasks(filters, sort, pagination);
      setTasks(response.data);
      setTotal(response.total);
      setTotalPages(response.totalPages);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch tasks';
      setError(message);
      console.error('Failed to fetch tasks:', err);
    } finally {
      setLoading(false);
    }
  }, [filters, sort, pagination]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const addTask = useCallback(async (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => {
    try {
      const newTask = await createTask(task);
      setTasks(prev => [newTask, ...prev]);
      setTotal(prev => prev + 1);
      return newTask;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create task';
      setError(message);
      throw err;
    }
  }, []);

  const editTask = useCallback(async (id: string, updates: Partial<Task>) => {
    try {
      const updated = await updateTask(id, updates);
      setTasks(prev => prev.map(t => t.id === id ? updated : t));
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update task';
      setError(message);
      throw err;
    }
  }, []);

  const removeTask = useCallback(async (id: string) => {
    try {
      await deleteTask(id);
      setTasks(prev => prev.filter(t => t.id !== id));
      setTotal(prev => prev - 1);
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete task';
      setError(message);
      throw err;
    }
  }, []);

  const bulkEdit = useCallback(async (updates: Array<{ id: string; changes: Partial<Task> }>) => {
    try {
      const updatedTasks = await bulkUpdateTasks(updates);
      setTasks(prev => {
        const updateMap = new Map(updatedTasks.map(t => [t.id, t]));
        return prev.map(t => updateMap.get(t.id) || t);
      });
      return updatedTasks;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update tasks';
      setError(message);
      throw err;
    }
  }, []);

  const bulkRemove = useCallback(async (ids: string[]) => {
    try {
      await bulkDeleteTasks(ids);
      setTasks(prev => prev.filter(t => !ids.includes(t.id)));
      setTotal(prev => prev - ids.length);
      setSelectedIds(new Set());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete tasks';
      setError(message);
      throw err;
    }
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(tasks.map(t => t.id)));
  }, [tasks]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const stats = useMemo(() => {
    const byStatus = tasks.reduce((acc, task) => {
      acc[task.status] = (acc[task.status] || 0) + 1;
      return acc;
    }, {} as Record<Task['status'], number>);

    const overdue = tasks.filter(t =>
      t.status !== 'completed' &&
      t.status !== 'cancelled' &&
      new Date(t.dueDate) < new Date()
    ).length;

    return { byStatus, overdue, total };
  }, [tasks, total]);

  return {
    tasks,
    total,
    totalPages,
    loading,
    error,
    selectedIds,
    stats,
    fetchTasks,
    addTask,
    editTask,
    removeTask,
    bulkEdit,
    bulkRemove,
    toggleSelect,
    selectAll,
    clearSelection,
  };
}
EOF

# 7. Update tests
cat > tests/formatters.test.ts << 'EOF'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDate,
  truncateText,
  formatRelativeTime,
  formatDueDate,
  pluralize,
  formatFileSize,
} from '../src/utils/formatters';

describe('formatters', () => {
  describe('formatDate', () => {
    it('formats Date object correctly', () => {
      const date = new Date('2024-01-15');
      const result = formatDate(date);
      expect(result).toContain('January');
      expect(result).toContain('15');
      expect(result).toContain('2024');
    });

    it('formats ISO string correctly', () => {
      const result = formatDate('2024-01-15T00:00:00.000Z');
      expect(result).toContain('January');
    });
  });

  describe('truncateText', () => {
    it('returns original text if shorter than max length', () => {
      expect(truncateText('hello', 10)).toBe('hello');
    });

    it('returns original text if equal to max length', () => {
      expect(truncateText('hello', 5)).toBe('hello');
    });

    it('truncates and adds ellipsis for long text', () => {
      expect(truncateText('hello world', 8)).toBe('hello...');
    });

    it('handles edge case with very short max length', () => {
      expect(truncateText('hello', 4)).toBe('h...');
    });
  });

  describe('formatRelativeTime', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns "just now" for times within a minute', () => {
      const now = new Date();
      expect(formatRelativeTime(now)).toBe('just now');
    });

    it('returns minutes ago', () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      expect(formatRelativeTime(fiveMinutesAgo)).toBe('5 minutes ago');
    });

    it('returns singular minute', () => {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      expect(formatRelativeTime(oneMinuteAgo)).toBe('1 minute ago');
    });

    it('returns hours ago', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      expect(formatRelativeTime(twoHoursAgo)).toBe('2 hours ago');
    });

    it('returns days ago', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
    });
  });

  describe('formatDueDate', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns overdue for past dates', () => {
      const yesterday = new Date('2024-01-14T12:00:00Z');
      const result = formatDueDate(yesterday);
      expect(result.isOverdue).toBe(true);
      expect(result.isUrgent).toBe(true);
      expect(result.text).toContain('overdue');
    });

    it('returns "Due today" for today', () => {
      const today = new Date('2024-01-15T18:00:00Z');
      const result = formatDueDate(today);
      expect(result.text).toBe('Due today');
      expect(result.isOverdue).toBe(false);
      expect(result.isUrgent).toBe(true);
    });

    it('returns "Due tomorrow"', () => {
      const tomorrow = new Date('2024-01-16T12:00:00Z');
      const result = formatDueDate(tomorrow);
      expect(result.text).toBe('Due tomorrow');
    });
  });

  describe('pluralize', () => {
    it('returns singular for count of 1', () => {
      expect(pluralize(1, 'task')).toBe('task');
    });

    it('returns plural for count > 1', () => {
      expect(pluralize(5, 'task')).toBe('tasks');
    });

    it('returns plural for count of 0', () => {
      expect(pluralize(0, 'task')).toBe('tasks');
    });

    it('uses custom plural form', () => {
      expect(pluralize(2, 'person', 'people')).toBe('people');
    });
  });

  describe('formatFileSize', () => {
    it('formats bytes', () => {
      expect(formatFileSize(500)).toBe('500 B');
    });

    it('formats kilobytes', () => {
      expect(formatFileSize(1024)).toBe('1 KB');
    });

    it('formats megabytes', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    });

    it('formats with decimals', () => {
      expect(formatFileSize(1536)).toBe('1.5 KB');
    });

    it('returns 0 B for zero', () => {
      expect(formatFileSize(0)).toBe('0 B');
    });
  });
});
EOF

echo ""
if [ "$NO_GIT" = false ]; then
  echo "Git status (uncommitted changes for /plannotator-review):"
  git diff --stat
else
  echo "Git: DISABLED (--no-git flag)"
fi
echo ""

# Set up local plugin via loader file
echo "Setting up local plugin..."
mkdir -p .opencode/plugin

# Create a loader file that re-exports from the source
# OpenCode only loads top-level .ts/.js files in the plugin directory
cat > .opencode/plugin/plannotator.ts << EOF
// Loader for local Plannotator plugin development
export * from "$PLUGIN_DIR/index.ts";
EOF

# Copy command files to local .opencode/command
mkdir -p .opencode/command
cp "$PLUGIN_DIR/commands/"*.md .opencode/command/

# Also install to global command directory (some OpenCode versions need this)
mkdir -p ~/.config/opencode/command
cp "$PLUGIN_DIR/commands/"*.md ~/.config/opencode/command/ 2>/dev/null || true

echo ""

# Create opencode.json config if --disable-sharing was passed
if [ "$DISABLE_SHARING" = true ]; then
  echo "Creating opencode.json with sharing disabled..."
  cat > opencode.json << 'EOF'
{
  "share": "disabled"
}
EOF
fi

echo "=== Sandbox Ready ==="
echo ""
echo "Directory: $SANDBOX_DIR"
if [ "$NO_GIT" = true ]; then
  echo "Git: DISABLED (--no-git)"
else
  echo "Git: enabled"
fi
if [ "$DISABLE_SHARING" = true ]; then
  echo "Sharing: DISABLED (via opencode.json config)"
else
  echo "Sharing: enabled (default)"
fi
echo ""
echo "To test:"
echo "  1. Plan mode: Ask the agent to plan something"
if [ "$NO_GIT" = false ]; then
  echo "  2. Code review: Run /plannotator-review"
fi
echo ""
echo "Launching OpenCode..."
echo ""

# Launch OpenCode
cd "$SANDBOX_DIR"
opencode
