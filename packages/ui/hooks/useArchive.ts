import { useState, useRef, useMemo, useCallback } from "react";
import type { ArchivedPlan } from "@plannotator/core/storage-types";
import type { UseLinkedDocReturn } from "./useLinkedDoc";
import type { ViewerHandle } from "../components/Viewer";
import type { Annotation } from "../types";
import { copyTextToClipboard } from "../utils/clipboard";
import { getPlanSaveSettings } from "../utils/planSave";

export interface UseArchiveOptions {
  markdown: string;
  viewerRef: React.RefObject<ViewerHandle | null>;
  linkedDocHook: UseLinkedDocReturn;
  setMarkdown: (md: string) => void;
  setAnnotations: (anns: Annotation[]) => void;
  setSelectedAnnotationId: (id: string | null) => void;
  setSubmitted: (s: "approved" | "denied" | null) => void;
}

export interface UseArchiveReturn {
  archiveMode: boolean;
  plans: ArchivedPlan[];
  selectedFile: string | null;
  isLoading: boolean;
  currentInfo: { status: ArchivedPlan["status"]; timestamp: string; title: string } | null;
  init: (plans: ArchivedPlan[]) => void;
  select: (filename: string) => Promise<void>;
  fetchPlans: () => Promise<void>;
  done: () => Promise<void>;
  copy: () => void;
  clearSelection: () => void;
}

export function useArchive(options: UseArchiveOptions): UseArchiveReturn {
  const {
    markdown,
    viewerRef,
    linkedDocHook,
    setMarkdown,
    setAnnotations,
    setSelectedAnnotationId,
    setSubmitted,
  } = options;

  const [archiveMode, setArchiveMode] = useState(false);
  const [plans, setPlans] = useState<ArchivedPlan[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const hasFetched = useRef(false);

  const customPath = useMemo(() => getPlanSaveSettings().customPath || undefined, []);

  const currentInfo = useMemo(() => {
    if (!selectedFile) return null;
    const plan = plans.find(p => p.filename === selectedFile);
    return plan ? { status: plan.status, timestamp: plan.timestamp, title: plan.title } : null;
  }, [selectedFile, plans]);

  const init = useCallback((archivePlans: ArchivedPlan[]) => {
    setArchiveMode(true);
    setPlans(archivePlans);
    if (archivePlans.length > 0) {
      setSelectedFile(archivePlans[0].filename);
    }
  }, []);

  const select = useCallback(async (filename: string) => {
    try {
      const params = new URLSearchParams({ filename });
      if (customPath) params.set("customPath", customPath);
      const res = await fetch(`/api/archive/plan?${params}`);
      if (!res.ok) return;
      const data = await res.json() as { markdown: string; filepath: string };

      if (archiveMode) {
        viewerRef.current?.clearAllHighlights();
        setMarkdown(data.markdown);
        setAnnotations([]);
        setSelectedAnnotationId(null);
        setSelectedFile(filename);
      } else {
        const buildUrl = (f: string) => {
          const p = new URLSearchParams({ filename: f });
          if (customPath) p.set("customPath", customPath);
          return `/api/archive/plan?${p}`;
        };
        linkedDocHook.open(filename, buildUrl, "archive");
        setSelectedFile(filename);
      }
    } catch { }
  }, [archiveMode, customPath, viewerRef, setMarkdown, setAnnotations, setSelectedAnnotationId, linkedDocHook]);

  const fetchPlans = useCallback(async () => {
    if (hasFetched.current || isLoading) return;
    hasFetched.current = true;
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (customPath) params.set("customPath", customPath);
      const qs = params.toString();
      const res = await fetch(`/api/archive/plans${qs ? `?${qs}` : ""}`);
      if (!res.ok) return;
      const data = await res.json() as { plans: ArchivedPlan[] };
      setPlans(data.plans);
      if (archiveMode && data.plans.length > 0) {
        const first = data.plans[0].filename;
        setSelectedFile(first);
        const fetchParams = new URLSearchParams({ filename: first });
        if (customPath) fetchParams.set("customPath", customPath);
        const planRes = await fetch(`/api/archive/plan?${fetchParams}`);
        if (planRes.ok) {
          const planData = await planRes.json() as { markdown: string };
          setMarkdown(planData.markdown);
        }
      }
    } catch {
      hasFetched.current = false;
    } finally {
      setIsLoading(false);
    }
  }, [archiveMode, customPath, isLoading, setMarkdown]);

  const done = useCallback(async () => {
    try {
      await fetch("/api/done", { method: "POST" });
      setSubmitted("approved");
    } catch { }
  }, [setSubmitted]);

  const copy = useCallback(() => {
    void copyTextToClipboard(markdown);
  }, [markdown]);

  const clearSelection = useCallback(() => {
    setSelectedFile(null);
  }, []);

  return {
    archiveMode,
    plans,
    selectedFile,
    isLoading,
    currentInfo,
    init,
    select,
    fetchPlans,
    done,
    copy,
    clearSelection,
  };
}
