// BADGE point-dose driver over vendored PARMA 4.10 (JAEA / T. Sato).
// Reads flight sample points on stdin, writes one dose-rate record per point on stdout.
//
// Non-commercial use. Cite:
//   T. Sato, PLOS ONE 10(12): e0144679 (2015)
//   T. Sato, PLOS ONE 11(8): e0160390 (2016)
//
// stdin  (whitespace separated, one point per line): year month day lat lon altFt g
// stdout (one per point):
//   PT <wIndex> <forceFieldMV> <cutoffRigidityGV> <depthGcm2> <effUSvPerHr> <h10USvPerHr>
//
// PARMA resolves relative paths ("input/...", "dcc/...") at runtime, so this binary
// must be executed with its working directory set to the PARMA vendor root.

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <iomanip>

using namespace std;

double getHPcpp(int, int, int);
double getrcpp(double, double);
double getdcpp(double, double);
double getSpecCpp(int, double, double, double, double, double);
double get511fluxCpp(double, double, double);
double getFFPfromWCpp(double);

static const int NEBIN = 140;
static const int NPART = 33;
static const int IE511 = 78; // energy bin carrying the 511 keV annihilation line

static double emid[NEBIN + 2];
static double ewid[NEBIN + 2];

static bool loadDcc(const string &name, double dcc[NPART + 1][NEBIN + 1])
{
    ifstream f("dcc/" + name + ".inp", ios::in);
    if (!f.is_open())
    {
        cerr << "ERR cannot open dcc/" << name << ".inp\n";
        return false;
    }
    string str;
    getline(f, str);
    getline(f, str);
    for (int ie = 1; ie <= NEBIN; ie++)
    {
        if (!getline(f, str))
        {
            cerr << "ERR truncated dcc/" << name << ".inp at bin " << ie << "\n";
            return false;
        }
        istringstream row(str);
        row >> emid[ie] >> ewid[ie];
        for (int ip = 0; ip <= NPART; ip++)
        {
            row >> dcc[ip][ie];
        }
    }
    return true;
}

int main()
{
    static double dccEff[NPART + 1][NEBIN + 1] = {}; // ICRP116 effective dose, isotropic irradiation
    static double dccH10[NPART + 1][NEBIN + 1] = {}; // H*(10) ambient dose equivalent

    if (!loadDcc("ICRP116", dccEff))
        return 1;
    if (!loadDcc("h10ICRP", dccH10))
        return 1;

    const double unitconv = 1.0e-6 * 3600.0; // matches PARMA main.cpp: -> uSv/h

    int iyear, imonth, iday;
    double glat, glong, altft, g;

    cout << scientific << setprecision(6);

    while (cin >> iyear >> imonth >> iday >> glat >> glong >> altft >> g)
    {
        double s = getHPcpp(iyear, imonth, iday); // force field potential (MV)
        double r = getrcpp(glat, glong);          // vertical cutoff rigidity (GV)
        double alti = altft * 0.3048 * 0.001;     // ft -> km
        double d = getdcpp(alti, glat);           // atmospheric depth (g/cm2)

        double doseEff = 0.0;
        double doseH10 = 0.0;

        for (int ie = 1; ie <= NEBIN; ie++)
        {
            double e = emid[ie];
            for (int ip = 0; ip <= NPART; ip++)
            {
                double flux = getSpecCpp(ip, s, r, d, e, g);
                if (ip == NPART && ie == IE511)
                {
                    flux += get511fluxCpp(s, r, d) / ewid[ie];
                }
                doseEff += flux * dccEff[ip][ie] * ewid[ie];
                doseH10 += flux * dccH10[ip][ie] * ewid[ie];
            }
        }

        cout << "PT " << s << " " << getFFPfromWCpp(s) << " " << r << " " << d << " "
             << doseEff * unitconv << " " << doseH10 * unitconv << "\n";
    }

    cout.flush();
    return 0;
}
