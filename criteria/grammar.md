# Grammar Check

## Description
Find grammatical errors in the paper text. Focus on subject-verb agreement, article usage, dangling modifiers, tense consistency, and sentence structure issues. Target clear grammatical mistakes, not stylistic preferences.

## Scope
text — Skip math environments, LaTeX commands, citation keys, and code listings.

## Positive Examples (these ARE problems)
- "The results shows that..." — subject-verb disagreement ("results" is plural, needs "show")
- "As shown in Figure 1, improving the performance." — dangling modifier / sentence fragment
- "We presents a novel approach" — subject-verb disagreement
- "An unique method" — wrong article ("a unique", because "unique" starts with a consonant sound)
- "The system don't require..." — subject-verb disagreement ("system" is singular)
- "We will showed that..." — tense inconsistency
- "There is several reasons..." — subject-verb disagreement ("reasons" is plural)

## Negative Examples (these are NOT problems)
- "Data is collected..." — "data" as singular is acceptable in modern academic English
- Sentence fragments inside figure/table captions — captions often omit subjects intentionally
- Bulleted or enumerated list items that are not full sentences
- Passive voice — this is a style choice, not a grammar error
- "Which" vs "that" distinction — this is a style preference in most contexts

## Checking Instructions
1. Skip content inside:
   - Math environments (`$...$`, `\[...\]`, `equation`, `align`, etc.)
   - Code listings (`lstlisting`, `verbatim`, `minted`)
   - `\cite{}`, `\ref{}`, `\label{}` and similar reference commands
2. Check subject-verb agreement in every sentence. The subject may be separated from the verb by prepositional phrases or relative clauses.
3. Check article usage: "a" before consonant sounds, "an" before vowel sounds. Watch for exceptions like "a university", "an hour".
4. Check for dangling modifiers: participial phrases at the start of a sentence must modify the grammatical subject.
5. Check tense consistency within paragraphs. Academic papers typically use present tense for general claims and past tense for specific experiments.
6. Check for sentence fragments that are not in lists or captions.
7. For each problem, quote the exact problematic text and explain the grammar rule being violated.
