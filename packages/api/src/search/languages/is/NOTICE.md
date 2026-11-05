# Icelandic language data

The `is` pack reads language data delivered outside this repository. This directory holds code only.

## Attribution

The Database of Icelandic Morphology. The Árni Magnússon Institute for Icelandic Studies. Author and editor Kristín Bjarnadóttir.

<https://bin.arnastofnun.is>

The data is used under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). While the pack is enabled, the product shows this credit in its search view.

## Changes to the data

Under CC BY-SA 4.0, these are all the changes made to the data the pack reads:

- `lemma-is/data-dist/*`, from the `lemma-is` package. Its author converted the data into a binary lemmatizer and two lookup files, and left out proper-noun-only readings that collide with common word forms. The binary used here holds a subset of the 350,000 most common forms. The files are otherwise as published.
- The delivered copy is trimmed: it holds the package's code, that subset and the lookup files, and leaves out the package's full binary.
- `fold-table.bin` is new, and described below.

## Derived table

`fold-table.bin` is adapted material made from the data, and carries its own notice here:

> Derived from The Database of Icelandic Morphology, The Árni Magnússon Institute for Icelandic Studies, author and editor Kristín Bjarnadóttir, <https://bin.arnastofnun.is>, through the `lookup.tsv.gz` and `lemmas.txt.gz` files of the `lemma-is` package. Every entry is rewritten: forms and lemmas are folded (þ→th, ð→d, æ→ae, ö→o, accents stripped, lowercase), entries that fold to the same form are merged, and each form lists its folded lemmas. Licensed under CC BY-SA 4.0.

## Provenance and delivery

The delivered directory's `manifest.json` records the upstream package checksums and the data source's own. It also holds a sha512 over the delivered files, which the pack checks at load against the constant in `index.ts`. The checksum holds none of the data.

Until the licence questions are answered (FR-045), the library, the data, the derived table and the stop and block lists stay out of this repository.
