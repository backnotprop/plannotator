export const CODE_FILE_REGEX = /(?:\.(tsx?|jsx?|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|sh|bash|zsh|sql|graphql|json|ya?ml|toml|ini|css|scss|less|xml|tf|lua|r|dart|ex|exs|vue|svelte|astro|zig|proto)|(?:^|\/)(Dockerfile|Makefile|Rakefile|Gemfile|Procfile|Vagrantfile|Brewfile|Justfile))$/i;

export const CODE_PATH_BARE_REGEX = /(?:\.{0,2}\/)?(?:[a-zA-Z0-9_@.\-\[\]]+\/)+[a-zA-Z0-9_.\-\[\]]+\.[a-zA-Z0-9]+/g;

const IMPLAUSIBLE_CHARS = /[{},*?\s]/;

export function isPlausibleCodeFilePath(input: string): boolean {
	return !IMPLAUSIBLE_CHARS.test(input);
}

export function isCodeFilePath(input: string): boolean {
	if (!isPlausibleCodeFilePath(input)) return false;
	return CODE_FILE_REGEX.test(input.replace(/#.*$/, ''))
		&& !input.startsWith('http://') && !input.startsWith('https://');
}

export function isCodeFilePathStrict(input: string): boolean {
	return input.includes('/') && isCodeFilePath(input);
}
