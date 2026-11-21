/**
 * Print output that can be bigger than a pipe or socket holds, and exit only after this settles: it does
 * once everything is written or the reader has gone. Without the wait the end is lost and the CLI still
 * exits 0, even with a reader keeping up; so is it through console.log on Bun 1.3 (cli-stdout-pipe.test.ts).
 */
export const writeWholeToStdout = (text: string): Promise<void> => new Promise((done) => void process.stdout.write(text, () => done()));
