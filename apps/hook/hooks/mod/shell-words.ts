/**
 * Split a slash command's raw argument text into words the way the skill's
 * `plannotator review $ARGUMENTS` line did in a shell: whitespace separates,
 * single quotes are literal, double quotes group (backslash escapes `"`, `\`,
 * `$` and a backtick inside them), and a backslash outside quotes escapes the
 * next character. Nothing is expanded: no variables, globs or command
 * substitution, so a word is passed to the CLI exactly as typed.
 *
 * An unterminated quote keeps what it opened (the rest of the line is one word).
 *
 * With `windows`, a backslash is an ordinary character everywhere, so a typed
 * `C:\Users\me\plan.md` stays whole; quotes still group words with spaces.
 */
export function splitShellWords(input: string, options: { windows?: boolean } = {}): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string

    if (quote === "'") {
      if (char === "'") quote = null
      else word += char
      continue
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (!options.windows && char === '\\' && index + 1 < input.length && '"\\$`'.includes(input[index + 1] as string)) {
        word += input[index + 1]
        index += 1
      } else {
        word += char
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      inWord = true
      continue
    }

    if (!options.windows && char === '\\' && index + 1 < input.length) {
      word += input[index + 1]
      inWord = true
      index += 1
      continue
    }

    if (/\s/.test(char)) {
      if (inWord) {
        words.push(word)
        word = ''
        inWord = false
      }
      continue
    }

    word += char
    inWord = true
  }

  if (inWord) words.push(word)
  return words
}
