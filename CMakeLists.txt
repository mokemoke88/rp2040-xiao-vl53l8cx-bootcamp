# SPDX-License-Identifier: MIT
cmake_minimum_required(VERSION 3.13)

# ボードの指定。pico_sdk_import.cmake より前に決めておく必要がある。
# 未指定だと SDK は Raspberry Pi Pico 扱いにし、XIAO RP2040 に必要な水晶の起動待ち延長などが入らない。
if(NOT DEFINED PICO_BOARD AND NOT DEFINED ENV{PICO_BOARD})
  set(PICO_BOARD seeed_xiao_rp2040 CACHE STRING "Board type")
endif()

include(pico_sdk_import.cmake)

project(xiao_vl53l8cx_bootcamp C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

pico_sdk_init()

# 自作のソース
set(BOOTCAMP_SOURCES
  src/main.c
  src/i2c_bus_recover.c
  src/platform.c
  src/uld_util.c
)

# ST の VL53L8CX ULD(BSD-3-Clause)。改変せずにそのままビルドする
set(ULD_DIR ${CMAKE_CURRENT_LIST_DIR}/third_party/vl53l8cx_uld)
set(ULD_SOURCES
  ${ULD_DIR}/src/vl53l8cx_api.c
  ${ULD_DIR}/src/vl53l8cx_plugin_detection_thresholds.c
  ${ULD_DIR}/src/vl53l8cx_plugin_motion_indicator.c
  ${ULD_DIR}/src/vl53l8cx_plugin_xtalk.c
)

add_executable(xiao_vl53l8cx_bootcamp ${BOOTCAMP_SOURCES} ${ULD_SOURCES})

# include/ には ULD が読む platform.h もあるので、ULD のソースからも見えるようにターゲット全体に付ける
target_include_directories(xiao_vl53l8cx_bootcamp PRIVATE
  ${CMAKE_CURRENT_LIST_DIR}/include
  ${ULD_DIR}/inc
)

# 警告は自分のソースにだけ付ける(target_compile_options だと SDK と ULD のソースにも付いてしまう)
set_source_files_properties(${BOOTCAMP_SOURCES} PROPERTIES COMPILE_OPTIONS "-Wall;-Wextra")

target_link_libraries(xiao_vl53l8cx_bootcamp
  pico_stdlib
  hardware_i2c
)

# printf の出力先は USB CDC だけにする(UART のピン D6 / D7 は使わない)
pico_enable_stdio_usb(xiao_vl53l8cx_bootcamp 1)
pico_enable_stdio_uart(xiao_vl53l8cx_bootcamp 0)

# .uf2 / .bin / .hex / .dis / .map を生成する
pico_add_extra_outputs(xiao_vl53l8cx_bootcamp)
