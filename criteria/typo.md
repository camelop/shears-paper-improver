# Typo Detection

## Description
Find typographical errors in the paper text. Focus on misspelled words, doubled words, and commonly confused word pairs. This criterion targets clear, unambiguous spelling mistakes — not stylistic preferences.

## Scope
text — Skip math environments, LaTeX commands, citation keys, labels, and custom macros.

## Positive Examples (these ARE problems)
- "recieve" should be "receive"
- "the the" is a duplicated word
- "seperate" should be "separate"
- "occurence" should be "occurrence"
- "acheive" should be "achieve"
- "definately" should be "definitely"
- "accomodate" should be "accommodate"

## Negative Examples (these are NOT problems)
- `\textbf{}` is a LaTeX command, not a typo
- System names defined by `\newcommand` (e.g., `\sys`) are not typos
- "et al." is correct Latin abbreviation
- "i.e." and "e.g." are correct abbreviations
- Proper nouns and acronyms (e.g., "OAuth", "RBAC", "LLM")
- Bibliography cite keys like `\cite{smith2024}` are not typos
- Content inside `\label{}`, `\ref{}`, `\input{}`, `\includegraphics{}`

## Checking Instructions
1. Skip content inside these environments/commands entirely:
   - Math: `$...$`, `\[...\]`, `equation`, `align`, `gather`, `multline`
   - References: `\cite{}`, `\ref{}`, `\label{}`, `\pageref{}`, `\cref{}`
   - File operations: `\input{}`, `\include{}`, `\includegraphics{}`
   - Any custom command definitions in the preamble
2. Check each word against standard English spelling, focusing on academic writing vocabulary.
3. Check for doubled words ("the the", "is is", "a a") — these are very common in academic writing.
4. Check for commonly confused pairs: affect/effect, complement/compliment, principal/principle, its/it's, than/then, lose/loose.
5. Do NOT flag: proper nouns, acronyms (words in ALL CAPS), bibliography entries, figure/table captions that reference filenames, or words that appear in the preamble's `\newcommand` definitions.
6. For each problem, provide the exact misspelled text and the correct spelling.
