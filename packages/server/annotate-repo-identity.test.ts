import { describeAnnotateRepoIdentity } from "../../tests/helpers/annotate-repo-identity-suite";
import { startAnnotateServer } from "./annotate";

describeAnnotateRepoIdentity("bun server", startAnnotateServer);
