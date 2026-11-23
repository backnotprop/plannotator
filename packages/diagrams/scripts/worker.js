import {renderDiagram} from "./index.js";

// The caller assigns an id so it can discard results from earlier edits.
self.onmessage = async ({data: {id, spec}}) => {
    try {
        self.postMessage({id, result: await renderDiagram(spec)});
    } catch (error) {
        self.postMessage({id, error: error.message});
    }
};
