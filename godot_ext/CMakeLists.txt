# rs_godot: thin GDExtension wrapper around rs_core (raycasts in, forces out).
# Build:  cmake -S godot_ext -B godot_ext/build && cmake --build godot_ext/build -j4
# Output: game/bin/librs_godot.linux.<target>.x86_64.so (loaded by game/bin/rs_godot.gdextension)
cmake_minimum_required(VERSION 3.17)
project(rs_godot LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# godot-cpp generated from the API of OUR Godot binary (4.7.2), only the classes we use.
set(GODOTCPP_CUSTOM_API_FILE "${CMAKE_CURRENT_SOURCE_DIR}/api/extension_api.json" CACHE FILEPATH "" FORCE)
set(GODOTCPP_BUILD_PROFILE "${CMAKE_CURRENT_SOURCE_DIR}/build_profile.json" CACHE FILEPATH "" FORCE)
set(GODOTCPP_DISABLE_EXCEPTIONS OFF CACHE BOOL "" FORCE)   # rs_core reports config errors as exceptions
add_subdirectory(godot-cpp)

set(RS_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(../core rs_core)

add_library(rs_godot SHARED src/register_types.cpp src/rs_vehicle.cpp src/rs_route.cpp src/rs_setup.cpp)
target_link_libraries(rs_godot PRIVATE godot::cpp rs_core)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(rs_godot PRIVATE -Wall -Wextra)
endif()
string(TOLOWER "${GODOTCPP_TARGET}" RS_TARGET)
set_target_properties(rs_godot PROPERTIES
  OUTPUT_NAME "rs_godot.linux.${RS_TARGET}.x86_64"
  PREFIX "lib"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../game/bin")
