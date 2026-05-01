export const CODE_FILE_REGEX = /(?:\.(tsx?|jsx?|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|sh|bash|zsh|sql|graphql|json|ya?ml|toml|ini|css|scss|less|xml|tf|lua|r|dart|ex|exs|vue|svelte|astro|zig|proto)|(?:^|\/)(Dockerfile|Makefile|Rakefile|Gemfile|Procfile|Vagrantfile|Brewfile|Justfile))$/i;

export function isCodeFilePath(input: string): boolean {
	return CODE_FILE_REGEX.test(input.replace(/#.*$/, ''))
		&& !input.startsWith('http://') && !input.startsWith('https://');
}

export function isCodeFilePathStrict(input: string): boolean {
	return input.includes('/') && isCodeFilePath(input);
}
