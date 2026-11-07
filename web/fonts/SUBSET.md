# Why these files are smaller than the ones upstream ships

`vazirmatn.woff2` here is a subset of the Vazirmatn release, not the whole
font. The full file is a hundred and eleven kilobytes and it is by a wide
margin the heaviest thing the panel sends; on a filtered mobile link it was a
visible part of the wait before the sign-in page settled. Eight hundred of its
glyphs cover scripts and symbols this panel never writes.

The subset keeps Arabic and its supplements, the Arabic presentation forms,
the Persian digits, the zero-width non-joiner that Persian cannot be set
without, basic Latin, and the punctuation the interface uses. It keeps every
OpenType layout feature, so the joining and the marks are untouched, and it
keeps the `wght` variable axis at its full 100-900, so every weight on the
page still comes out of this one file. Rendered side by side against the full
font at seven weights, with Persian digits, half-spaces and Latin fallback,
the two are pixel for pixel identical.

Seventy-two kilobytes instead of a hundred and nine.

To rebuild it from an upstream release:

    pyftsubset vazirmatn-upstream.woff2 \
      --output-file=vazirmatn.woff2 --flavor=woff2 \
      --unicodes="U+0020-007E,U+00A0,U+00AB,U+00BB,U+0600-06FF,U+0750-077F,\
U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF,U+200C-200F,U+2010-2027,U+2030,U+2039,\
U+203A,U+2066-2069,U+20AC,U+FDFC" \
      --layout-features='*' --no-hinting --desubroutinize

Vazirmatn is under the SIL Open Font Licence 1.1 (see `OFL.txt`), which allows
a modified copy; the upstream copyright line declares no Reserved Font Name,
so the subset keeps the family name. Figtree (`figtree.woff2`, `figtree-OFL.txt`)
is shipped as released.
