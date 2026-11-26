import {renderDiagram} from "./index.js";

// The caller assigns an id so it can discard results from earlier edits.
self.onmessage = async ({data}) => {
    const {id,spec}=data ?? {};
    try {
        self.postMessage({id, result: await renderDiagram(spec)});
    } catch (error) {
        self.postMessage({id, error: error instanceof Error ? error.message : String(error)});
    }
};
