export type UILanguage = 'auto' | 'en' | 'zh-CN';

export interface LanguageOption {
  id: UILanguage;
  label: string;
  nativeLabel: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { id: 'auto', label: 'Auto (System)', nativeLabel: '自动（跟随系统）' },
  { id: 'en', label: 'English', nativeLabel: 'English' },
  { id: 'zh-CN', label: 'Simplified Chinese', nativeLabel: '简体中文' },
];

export interface TranslationDictionary {
  common: {
    save: string;
    cancel: string;
    close: string;
    confirm: string;
    delete: string;
    edit: string;
    copy: string;
    copied: string;
    loading: string;
    search: string;
    auto: string;
    system: string;
    enabled: string;
    disabled: string;
    on: string;
    off: string;
    status: string;
    help: string;
  };
  actions: {
    approve: string;
    approveWithNotes: string;
    deny: string;
    denyWithAnnotations: string;
    sendFeedback: string;
    copyFeedback: string;
    feedbackCopied: string;
    planDiff: string;
    exitPlanDiff: string;
    addAnnotation: string;
    askAi: string;
    askThisSession: string;
    clearAnnotations: string;
    exportAnnotations: string;
    importAnnotations: string;
    keyboardShortcuts: string;
    settings: string;
  };
  settings: {
    title: string;
    tabs: {
      general: string;
      display: string;
      theme: string;
      git: string;
      analysis: string;
      saving: string;
      labels: string;
      vim: string;
      shortcuts: string;
      ai: string;
      files: string;
      obsidian: string;
      bear: string;
      octarine: string;
      hooks: string;
    };
    language: {
      title: string;
      description: string;
      auto: string;
      en: string;
      zhCN: string;
    };
    identity: {
      title: string;
      description: string;
      placeholder: string;
      useGitName: string;
      regenerate: string;
    };
    planWidth: {
      title: string;
      description: string;
      compact: string;
      compactHint: string;
      default: string;
      defaultHint: string;
      wide: string;
      wideHint: string;
    };
    appearance: {
      title: string;
      mode: string;
      light: string;
      dark: string;
      system: string;
    };
  };
  plan: {
    planTitle: string;
    version: string;
    revision: string;
    unsavedChanges: string;
    waitingForDecision: string;
    reviewApproved: string;
    reviewDenied: string;
    annotationsCount: string;
    noAnnotations: string;
    notesPlaceholder: string;
  };
}
