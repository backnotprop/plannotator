import { describeAnnotateRepoIdentity } from "../../../tests/helpers/annotate-repo-identity-suite";
import { startAnnotateServer } from "./serverAnnotate.ts";

describeAnnotateRepoIdentity("pi server", startAnnotateServer);
