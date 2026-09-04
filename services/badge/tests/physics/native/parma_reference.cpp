// PARMA reference dose generator for the BADGE cross-check.
//
// This is vendor/PARMA/main.cpp with the PHYSICS LOOP LEFT BYTE-IDENTICAL and
// only the I/O re-plumbed for testing:
//   - condition file path taken from argv[1] (main.cpp hard-codes "Ang-EnergyDep")
//   - only the dose summary is written, to stdout, as "s r d g totalEff"
//   - SpecOut / AngOut file writing removed (not needed here)
//
// It links the same vendor/PARMA/subroutines.cpp as BADGE's own route_dose.cpp,
// so a disagreement between the two binaries on the same input is a real
// transcription bug in route_dose.cpp, not a physics difference. Same engine =
// same numbers PARMA's EXPACS frontend would produce.
//
// Non-commercial use. Cite T. Sato, PLOS ONE 10(12):e0144679 (2015) and
// 11(8):e0160390 (2016).
//
// Build: tests/physics/native/build-reference.sh
// Run  (cwd MUST be vendor/PARMA/, like route_dose):
//   ./parma_reference <path-to-condition-file>

#include <iostream>
#include <string>
#include <fstream>
#include <sstream>
#include <iomanip>

using namespace std;

double getHPcpp(int, int, int);
double getrcpp(double, double);
double getdcpp(double, double);
double getSpecCpp(int, double, double, double, double, double);
double get511fluxCpp(double, double, double);

int main(int argc, char **argv)
{
    if (argc < 2)
    {
        cerr << "usage: parma_reference <condition-file>\n";
        return 2;
    }

    const int nebin = 140;
    const int npart = 33;
    const int ie511 = 78;

    double emid[nebin + 2], ewid[nebin + 2];
    double dcc[npart + 1][nebin + 1] = {};

    const string dccname = "ICRP116"; // ICRP-116 effective dose, isotropic (uSv/h)
    const double unitconv = 1.0e-6 * 3600; // identical to main.cpp / route_dose.cpp

    int isout, istyle;
    int ip, iyear, imonth, iday, ie;
    double e, glat, glong, alti, s, r, d, dori, g;

    ifstream conf(argv[1], ios::in);
    if (!conf.is_open())
    {
        cerr << "cannot open condition file: " << argv[1] << "\n";
        return 2;
    }
    string str;
    getline(conf, str);
    {
        istringstream head(str);
        head >> isout >> istyle;
    }

    // Dose conversion coefficients (same load as main.cpp: two header lines,
    // then 140 rows of "emid ewid dcc[0..33]").
    ifstream dccf("dcc/" + dccname + ".inp", ios::in);
    if (!dccf.is_open())
    {
        cerr << "cannot open dcc/" << dccname << ".inp (run from vendor/PARMA/)\n";
        return 1;
    }
    getline(dccf, str);
    getline(dccf, str);
    for (ie = 1; ie <= nebin; ie++)
    {
        getline(dccf, str);
        istringstream row(str);
        row >> emid[ie] >> ewid[ie];
        for (ip = 0; ip <= npart; ip++)
            row >> dcc[ip][ie];
    }
    emid[nebin + 1] = 0.0;
    ewid[nebin + 1] = 1.0;

    cout << scientific << setprecision(8);

    while (true)
    {
        getline(conf, str);
        if (conf.eof())
            break;
        if (str.find_first_not_of(" \t\r\n") == string::npos)
            continue;
        istringstream row(str);

        if (istyle == 0)
        {
            row >> s >> r >> d >> g; // W-index, Rc(GV), depth(g/cm2), g
        }
        else if (istyle >= 1 && istyle <= 3)
        {
            row >> iyear >> imonth >> iday >> glat >> glong >> dori >> g;
            s = getHPcpp(iyear, imonth, iday);
            r = getrcpp(glat, glong);
            if (istyle == 1)
                d = dori;
            else if (istyle == 2)
                d = getdcpp(dori * 0.001, glat);
            else
                d = getdcpp(dori * 0.3048 * 0.001, glat); // ft -> km
        }
        else if (istyle == 4)
        {
            row >> iyear >> imonth >> iday >> r >> d >> g;
            s = getHPcpp(iyear, imonth, iday);
        }
        else
        {
            cerr << "unsupported istyle " << istyle << "\n";
            return 2;
        }

        double doseEff = 0.0;
        for (ie = 1; ie <= nebin; ie++)
        {
            e = emid[ie];
            for (ip = 0; ip <= npart; ip++)
            {
                double flux = getSpecCpp(ip, s, r, d, e, g);
                if (ip == npart && ie == ie511)
                    flux += get511fluxCpp(s, r, d) / ewid[ie];
                doseEff += flux * dcc[ip][ie] * ewid[ie];
            }
        }

        cout << s << " " << r << " " << d << " " << g << " " << doseEff * unitconv << "\n";
    }

    return 0;
}
