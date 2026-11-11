import mermaid from 'mermaid';
import { MERMAID_CONFIG, setMermaidRuntime } from './mermaid';

mermaid.initialize(MERMAID_CONFIG);
setMermaidRuntime(mermaid, 'plannotator-mermaid-eager');
