# Term Use Consistency

## Description
Find inconsistent usage of technical terms, spellings, hyphenation, and capitalization throughout the paper. When the same concept is referred to in multiple ways, flag the minority usage as inconsistent.

## Scope
all — Check everything including headings, captions, and abstract. Only skip math-mode content and raw LaTeX commands.

## Positive Examples (these ARE problems)
- Using both "run-time" and "runtime" in different places — pick one and use it consistently
- Using both "tool-calling" and "tool calling" inconsistently
- Using "LLM" in some places and "large language model" in others after the first definition
- Capitalizing "Access Control" in some places but "access control" in others (outside of headings)
- Using both "e.g." and "e.g.," (with and without comma) inconsistently
- Using both "Fig." and "Figure" when referencing figures in running text

## Negative Examples (these are NOT problems)
- Using the full term "large language model" at first mention and "LLM" afterwards — this is standard practice
- Different capitalization in headings vs. body text — headings follow title case
- Using both singular and plural forms of the same term ("agent" vs "agents") as grammar requires
- Different formatting in different contexts (e.g., monospace in code examples, regular in text)

## Checking Instructions
1. First pass: build a complete inventory of all technical terms, abbreviations, and their variants throughout the paper. For each term, record:
   - All spelling variants (hyphenated, compound, separate words)
   - Capitalization patterns (outside of headings/titles)
   - Abbreviation usage patterns
2. Second pass: for each term with multiple variants, determine which is the majority usage.
3. Flag minority usages as inconsistencies. Include:
   - The inconsistent term as found
   - The majority/preferred form
   - Counts of each variant (e.g., "runtime" appears 12 times, "run-time" appears 3 times)
4. Special cases to check:
   - Figure/Table references: "Fig." vs "Figure", "Tab." vs "Table"
   - Latin abbreviations: consistent use of periods and commas with "i.e.", "e.g.", "et al."
   - Hyphenation of compound modifiers: "least-privilege" vs "least privilege" when used as adjective
5. Do NOT flag the first occurrence of a full term before its abbreviation is introduced.
6. Group related inconsistencies together when they concern the same term.
