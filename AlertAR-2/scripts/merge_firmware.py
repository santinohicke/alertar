"""Wokwi recibe bootloader, particiones y aplicación en una sola imagen."""
Import("env")


def merge(source, target, env):
    import subprocess
    from pathlib import Path

    build = Path(env.subst("$BUILD_DIR"))
    esptool = Path(env.PioPlatform().get_package_dir("tool-esptoolpy")) / "esptool.py"
    subprocess.check_call([
        env.subst("$PYTHONEXE"), str(esptool), "--chip", "esp32", "merge_bin",
        "-o", str(build / "firmware.merged.bin"), "--flash_mode", "dio",
        "--flash_freq", "40m", "--flash_size", "4MB",
        "0x1000", str(build / "bootloader.bin"),
        "0x8000", str(build / "partitions.bin"),
        "0x10000", str(build / "firmware.bin"),
    ])


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", merge)
