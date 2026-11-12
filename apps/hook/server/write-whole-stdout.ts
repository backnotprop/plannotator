export const writeWholeToStdout = (text: string): Promise<void> => new Promise((done) => void process.stdout.write(text, () => done()));
