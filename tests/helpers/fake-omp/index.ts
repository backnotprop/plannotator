/**
 * Puts a fake Oh My Pi (`omp`) on a test's PATH: the fake Pi (tests/helpers/fake-pi) run as Oh My Pi 19.2.1's source
 * has it (`omp/<version>`, its `ready` frame, its own session ids read with `get_state`, `set_session_name`,
 * `--resume <id>`, a session file written from the first answer on, `~/.omp/agent`), with Plannotator's Pi
 * extension recorded as an Oh My Pi plugin in the test HOME (`~/.omp/plugins/package.json` and its lock), as
 * `omp plugin install @plannotator/pi-extension` leaves it. Never the real Oh My Pi.
 */
import { installFakePi, type FakePi, type FakePiConfig } from "../fake-pi";

export type { FakePiConfig as FakeOmpConfig } from "../fake-pi";

export function installFakeOmp(input: { bin: string; state: string; home: string; config?: FakePiConfig }): FakePi {
  return installFakePi({ ...input, flavor: "omp" });
}
