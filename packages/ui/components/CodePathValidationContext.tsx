import { createContext, useContext } from "react";
import type { ValidatedMap } from "../hooks/useValidatedCodePaths";

export interface CodePathValidationContextValue {
	validated: ValidatedMap;
	ready: boolean;
}

export const CodePathValidationContext =
	createContext<CodePathValidationContextValue | null>(null);

export function useCodePathValidation(): CodePathValidationContextValue | null {
	return useContext(CodePathValidationContext);
}
