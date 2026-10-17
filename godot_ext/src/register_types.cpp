// GDExtension entry point: registers the RS* classes with Godot.
#include <gdextension_interface.h>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/defs.hpp>
#include <godot_cpp/godot.hpp>
#include "rs_route.hpp"
#include "rs_setup.hpp"
#include "rs_vehicle.hpp"

using namespace godot;

static void initialize(ModuleInitializationLevel level) {
    if (level != MODULE_INITIALIZATION_LEVEL_SCENE) return;
    GDREGISTER_CLASS(RSVehicle);
    GDREGISTER_CLASS(RSRoute);
    GDREGISTER_CLASS(RSRace);
    GDREGISTER_CLASS(RSSetup);
}

static void uninitialize(ModuleInitializationLevel) {}

extern "C" GDExtensionBool GDE_EXPORT rs_godot_init(GDExtensionInterfaceGetProcAddress get_proc_address,
                                                    GDExtensionClassLibraryPtr library,
                                                    GDExtensionInitialization* init) {
    GDExtensionBinding::InitObject obj(get_proc_address, library, init);
    obj.register_initializer(initialize);
    obj.register_terminator(uninitialize);
    obj.set_minimum_library_initialization_level(MODULE_INITIALIZATION_LEVEL_SCENE);
    return obj.init();
}
