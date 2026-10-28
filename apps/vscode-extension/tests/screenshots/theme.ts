/** Shared by the screenshot scripts. */

/** A subset of VS Code's Dark Modern theme variables the webview reads. */
export const THEME = `
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, monospace;
  --vscode-foreground: #cccccc; --vscode-editor-foreground: #cccccc; --vscode-sideBar-background: #181818; --vscode-descriptionForeground: #9d9d9d; --vscode-editor-background: #1f1f1f;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc; --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-focusBorder: #0078d4; --vscode-errorForeground: #f85149; --vscode-editorWarning-foreground: #cca700;
  --vscode-inputValidation-infoBackground: #0b2a45; --vscode-inputValidation-warningBackground: #352a05; --vscode-inputValidation-warningBorder: #b89500;
  --vscode-panel-border: #2b2b2b; --vscode-widget-border: #313131; --vscode-textLink-foreground: #4daafc; --vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8;
  --vscode-testing-iconPassed: #73c991; --vscode-list-hoverBackground: #2a2d2e; --vscode-textCodeBlock-background: #2b2b2b;
}
body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); margin: 0; }
`;
