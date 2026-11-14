import type { ChangedFileView } from '../components/FileViewSwitch';

export interface PaneFileViewParams {
  view?: ChangedFileView;
  viewPath?: string;
}

export function paneFileView(params: PaneFileViewParams | undefined, filePath: string | null): ChangedFileView {
  return params?.view && params.viewPath === filePath ? params.view : 'changes';
}
