/**
 * Supabase client for collaborative sessions
 *
 * Provides real-time sync for annotations across multiple users.
 * Falls back gracefully when Supabase is not configured.
 */

import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

// Get Supabase config from environment variables
// These are set at build time via Vite's import.meta.env
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Singleton client instance
let supabaseClient: SupabaseClient | null = null;

/**
 * Check if Supabase is configured
 */
export function isSupabaseConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/**
 * Get the Supabase client singleton
 * Returns null if Supabase is not configured
 */
export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }

  if (!supabaseClient) {
    supabaseClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  }

  return supabaseClient;
}

// Database types for Supabase tables
export interface DbSession {
  id: string;
  plan_markdown: string;
  created_at: string;
  updated_at: string;
}

export interface DbAnnotation {
  id: string;
  session_id: string;
  type: string;
  original_text: string;
  text: string | null;
  author: string | null;
  position_context: string | null;
  image_paths: string[] | null;
  created_at: string;
  deleted_at: string | null;
}

// Realtime event types
export type AnnotationChangeEvent = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: DbAnnotation | null;
  old: DbAnnotation | null;
};

export type { SupabaseClient, RealtimeChannel };
