let clickAWord = true;

export function setClickAWord(on: boolean): void {
  clickAWord = on;
}

export function resetClickAWord(): void {
  clickAWord = true;
}

export function getClickAWord(): boolean {
  return clickAWord;
}
