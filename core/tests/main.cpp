// Headless test runner: no game engine involved anywhere.
//   rs_tests            -> run all tests
//   rs_tests braking    -> run one test
#include <cstdio>
#include <exception>
#include "harness.hpp"

int main(int argc, char** argv) {
    auto& all = test::Registry::all();
    int ran = 0;
    for (auto& [name, fn] : all) {
        if (argc > 1 && name != argv[1]) continue;
        std::printf("== %s\n", name.c_str());
        try {
            fn();
        } catch (const std::exception& e) {
            std::printf("  [FAIL] exception: %s\n", e.what());
            ++test::failures();
        }
        ++ran;
    }
    if (ran == 0) {
        std::printf("no test named '%s'\n", argc > 1 ? argv[1] : "");
        return 2;
    }
    std::printf("\n%d test group(s), %d failed check(s)\n", ran, test::failures());
    return test::failures() == 0 ? 0 : 1;
}
