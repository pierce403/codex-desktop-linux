# Codex Micro

This default-off feature enables the OpenAI x Work Louder Codex Micro over USB
and Bluetooth on Linux. It reuses the service and device kit bundled with the
upstream app; it does not reimplement the device protocol.

## Enable

Add the feature to the gitignored `linux-features/features.json`:

```json
{
  "enabled": ["codex-micro"]
}
```

Then rebuild or package the app through the normal project workflow. Do not run
the app as root.

## Install the udev rule

Every install type requires this one-time host setup, including Debian, RPM,
pacman, AppImage, Nix, Home Manager, and source installs. Native packages carry
the runtime library dependencies, but deliberately do not change host udev
policy.

From a repository checkout:

```bash
sudo install -Dm0644 \
  linux-features/codex-micro/resources/70-codex-micro.rules \
  /etc/udev/rules.d/70-codex-micro.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=hidraw
```

The built app also carries the same rule at
`.codex-linux/features/codex-micro/70-codex-micro.rules`. Replug the USB cable
or reconnect Bluetooth after installing the rule.

## Runtime libraries

The verified x64 binding directly needs:

```text
libudev.so.1
libusb-1.0.so.0
libstdc++.so.6
libm.so.6
libgcc_s.so.1
libpthread.so.0
libc.so.6
```

The key non-baseline libraries are `libudev.so.1` and `libusb-1.0.so.0`.
Native packages declare them through these distro packages or capabilities:

- Debian: `libudev1`, `libusb-1.0-0`
- RPM capabilities: `libudev.so.1%{codex_elf_suffix}`,
  `libusb-1.0.so.0%{codex_elf_suffix}`; on Fedora these are provided by
  `systemd-libs` and `libusb1`
- Arch/pacman: `systemd-libs`, `libusb`

Flake-provided Nix and Home Manager installs include these libraries in their
RPATH closure. For AppImage, source, or other manually assembled installs,
provide equivalent runtime libraries in the launch environment. To verify a
built app, locate its staged `node-napi-v4.node` and run:

```bash
ldd /path/to/node-napi-v4.node
```

Every dependency must resolve; the output must not contain `not found`.

## Bluetooth

Pair the Micro through the desktop Bluetooth settings before opening Codex.
Channel selection and pairing mode are device operations; see the
[Work Louder setup guide](https://worklouder.cc/micro-setup).

## Implementation notes

The upstream app currently includes `node-hid` 3.3.0 with only its macOS native
binding. This feature verifies that exact package and stages the pinned,
hash-verified Linux x64 or arm64 prebuild. It never compiles native code or
falls back to an unverified artifact.

The udev rules are limited to the observed Work Louder VID/PID `303a:8360`, USB
HID interface `00`, and the corresponding Bluetooth HID bus identity. The USB
rule imports `usb_id` itself before matching the interface, so it does not rely
on another rule having populated those properties. Access is granted to the
active desktop user through `uaccess`; devices are not made world-writable.

Upstream package drift, a mismatched native artifact, a missing pinned prebuild,
or an unsupported architecture causes the enabled feature to reject candidate
promotion.

## Verify

After connecting the device, confirm that the Codex Micro settings surface
reports it as connected and test the buttons, dial, joystick, and lighting.
For permission failures, identify the matching `/dev/hidraw*` node with
`udevadm info` and confirm that the logged-in user has read/write access.

Run the automated checks with:

```bash
node --test linux-features/codex-micro/test.js
node --test scripts/lib/linux-features.test.js
```
