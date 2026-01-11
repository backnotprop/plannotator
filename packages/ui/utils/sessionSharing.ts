/**
 * Session-based collaborative sharing utilities
 *
 * Enables real-time collaboration via Supabase sessions.
 * Sessions are identified by UUID and contain a plan + synced annotations.
 */

import { getSupabase, isSupabaseConfigured, DbSession, DbAnnotation } from '../lib/supabase';
import { Annotation, AnnotationType, CollaborativeSession } from '../types';

/**
 * Generate a shareable session URL
 * Uses current host for local testing, falls back to production URL
 */
export function getSessionUrl(sessionId: string): string {
  const baseUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/session`
    : 'https://share.plannotator.ai/session';
  return `${baseUrl}/${sessionId}`;
}

/**
 * Parse a session ID from the current URL path
 * Returns null if not on a session URL
 */
export function parseSessionFromUrl(): string | null {
  const path = window.location.pathname;
  const match = path.match(/^\/session\/([a-f0-9-]+)$/i);
  return match ? match[1] : null;
}

/**
 * Create a new collaborative session
 * Returns the session ID or null if creation failed
 */
export async function createSession(planMarkdown: string): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn('Supabase not configured - cannot create session');
    return null;
  }

  const { data, error } = await supabase
    .from('sessions')
    .insert({ plan_markdown: planMarkdown })
    .select('id')
    .single();

  if (error) {
    console.error('Failed to create session:', error);
    return null;
  }

  return data.id;
}

/**
 * Fetch a session by ID
 * Returns the session data or null if not found
 */
export async function fetchSession(sessionId: string): Promise<CollaborativeSession | null> {
  const supabase = getSupabase();
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (error || !data) {
    console.error('Failed to fetch session:', error);
    return null;
  }

  const session = data as DbSession;
  return {
    id: session.id,
    planMarkdown: session.plan_markdown,
    createdAt: new Date(session.created_at),
    updatedAt: new Date(session.updated_at),
  };
}

/**
 * Fetch all annotations for a session
 */
export async function fetchSessionAnnotations(sessionId: string): Promise<Annotation[]> {
  const supabase = getSupabase();
  if (!supabase) {
    return [];
  }

  const { data, error } = await supabase
    .from('annotations')
    .select('*')
    .eq('session_id', sessionId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to fetch annotations:', error);
    return [];
  }

  return (data as DbAnnotation[]).map(dbAnnotationToAnnotation);
}

/**
 * Add an annotation to a session
 */
export async function addSessionAnnotation(
  sessionId: string,
  annotation: Annotation
): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) {
    return false;
  }

  const dbAnnotation = annotationToDbAnnotation(sessionId, annotation);

  const { error } = await supabase
    .from('annotations')
    .insert(dbAnnotation);

  if (error) {
    console.error('Failed to add annotation:', error);
    return false;
  }

  return true;
}

/**
 * Remove an annotation from a session (soft delete)
 */
export async function removeSessionAnnotation(annotationId: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) {
    return false;
  }

  const { error } = await supabase
    .from('annotations')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', annotationId);

  if (error) {
    console.error('Failed to remove annotation:', error);
    return false;
  }

  return true;
}

// Convert database annotation to app annotation
function dbAnnotationToAnnotation(db: DbAnnotation): Annotation {
  const typeMap: Record<string, AnnotationType> = {
    'DELETION': AnnotationType.DELETION,
    'REPLACEMENT': AnnotationType.REPLACEMENT,
    'COMMENT': AnnotationType.COMMENT,
    'INSERTION': AnnotationType.INSERTION,
    'GLOBAL_COMMENT': AnnotationType.GLOBAL_COMMENT,
  };

  return {
    id: db.id,
    blockId: '', // Will be populated during highlight restoration
    startOffset: 0,
    endOffset: 0,
    type: typeMap[db.type] || AnnotationType.COMMENT,
    text: db.text || undefined,
    originalText: db.original_text,
    createdA: new Date(db.created_at).getTime(),
    author: db.author || undefined,
    imagePaths: db.image_paths || undefined,
  };
}

// Convert app annotation to database annotation
function annotationToDbAnnotation(sessionId: string, ann: Annotation): Omit<DbAnnotation, 'created_at' | 'deleted_at'> {
  // Build position context from surrounding text for text-finding on restore
  const positionContext = ann.originalText.length > 0
    ? ann.originalText.substring(0, 100) // First 100 chars as context
    : null;

  return {
    id: ann.id,
    session_id: sessionId,
    type: ann.type,
    original_text: ann.originalText,
    text: ann.text || null,
    author: ann.author || null,
    position_context: positionContext,
    image_paths: ann.imagePaths || null,
  };
}

/**
 * Check if collaborative sessions are available
 */
export function isCollaborativeAvailable(): boolean {
  return isSupabaseConfigured();
}
