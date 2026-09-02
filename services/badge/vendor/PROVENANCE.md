# Vendored dependencies

## PARMA 4.10 (C++ port)

- **Upstream:** https://github.com/WeiMXi/PARMA
- **Commit vendored:** `6ff37cacb8cf003e2fc269963f9a08f812407264` (2023-08-04)
- **Retrieved:** 2026-09-01
- **Version banner in source:** PARMA Version 4.10 (2021/03/21)
- **Origin:** C++ translation of the Fortran PARMA/EXPACS distributed by JAEA
  (https://phits.jaea.go.jp/expacs)

### Licence — read before any change in how BADGE is distributed

Upstream readme, verbatim:

> For non-commercial use, you should refer the following manuscripts in any published use of this program,
> T.Sato, Analytical model for estimating terrestrial cosmic-ray fluxes nearly anytime and anywhere in the world; Extension of PARMA/EXPACS, 10(12): e0144679 (2015)
> T.Sato, Analytical model for estimating the zenith angle dependence of terrestrial cosmic ray fluxes, PLOS ONE, 11(8): e0160390 (2016)
> The commercial use of this program is NOT allowed with a prior agreement with JAEA

**Status for BADGE:** personal / non-commercial use only. Luis confirmed 2026-09-01 that
BADGE is not being built for sale or distribution. If that ever changes — a paid product,
a hosted service, anything commercial — this dependency needs a prior agreement with JAEA
(nsed-expacs@jaea.go.jp) before shipping.

The two Sato citations above are mandatory in any published use.

### Local modifications

None. The vendor tree is pristine; BADGE's driver (`engine/native/route_dose.cpp`) is
compiled against `subroutines.cpp` and the build output lands at `vendor/PARMA/route_dose`
because PARMA resolves its `input/` and `dcc/` databases by relative path at runtime.

The upstream `.git` directory was removed so the tree commits cleanly into the Jarvis repo.

### What PARMA supplies that BADGE therefore does not reimplement

- `getrcpp` — vertical cutoff rigidity from a bundled 1° global grid (`input/CORdata.inp`,
  361 × 181). Resolves the §12 open question about shipping a rigidity grid.
- `getHPcpp` — solar modulation (W-index) from bundled daily force-field tables
  (`input/FFPtable.day`, Usoskin-derived). **Coverage ends 2023-05-03.**
- `getdcpp` — atmospheric depth from altitude (US Standard Atmosphere 1976 / NRLMSISE).
- `dcc/ICRP116.inp` and `dcc/h10ICRP.inp` — fluence-to-dose conversion for effective dose
  and H*(10).
