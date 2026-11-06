import { describeAnnotateRepoIdentity } from "../../../tests/helpers/annotate-repo-identity-suite.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

describeAnnotateRepoIdentity("pi server", startAnnotateServer);
