import { returnFromSqlite } from "../return";

const [dataDir, stopAt, nth] = process.argv.slice(2);
let seen = 0;
returnFromSqlite(dataDir!, {
  now: () => new Date("2026-11-13T10:00:00Z"),
  step: (name) => {
    if (name === stopAt && ++seen === Number(nth)) process.kill(process.pid, "SIGKILL");
  },
});
