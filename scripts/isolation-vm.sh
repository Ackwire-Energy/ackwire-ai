#!/usr/bin/env bash
# CI's isolation-root job, Debian 13 leg: boots the agentes.chat Cloud's release (Debian's own kernel, and systemd
# built with BPF_FRAMEWORK, which the agents' bind policy needs) in QEMU and runs the isolation test there as root.
# The guest's second serial port is this job's log (its console, where a getty starts, goes to a file), and the
# test's exit code comes back on it.
# Usage: scripts/isolation-vm.sh <bundled test> <runner bundle> <image folder (kept between runs)>
set -euo pipefail
test_js=$1 runner=$2 images=$3
# A dated build of the generic image (Debian's standard kernel, as on a VPS), checked against the SHA512SUMS
# published beside it.
image_url=https://cloud.debian.org/images/cloud/trixie/20261026-2643/debian-13-generic-amd64-20261026-2643.qcow2
image_sha512=5bd891c6e62d01639f52a5587b72a4607421e445732214be787dba6043cf9797a6ff90bed982aada6a6c7e619f1f956d961c4fad76757171abd607920aac098a
work=${RUNNER_TEMP:-/tmp}/isolation-vm
image=$images/debian-13.qcow2

mkdir -p "$images"
if ! echo "$image_sha512  $image" | sha512sum -c --quiet - 2> /dev/null; then
  curl -fsSL --retry 3 -o "$image" "$image_url"
  echo "$image_sha512  $image" | sha512sum -c --quiet -
fi
rm -rf "$work"
mkdir -p "$work/seed"
qemu-img create -q -f qcow2 -F qcow2 -b "$image" "$work/disk.qcow2" 12G

# The NoCloud seed (volume cidata): cloud-init's files, and what the guest runs.
seed=$work/seed
cp "$test_js" "$seed/isolation.root.test.js"
cp "$runner" "$seed/agentes-runner.mjs"
cp "$(command -v bun)" "$seed/bun"
printf 'instance-id: isolation\nlocal-hostname: isolation\n' > "$seed/meta-data"
cat > "$seed/user-data" << 'EOF'
#cloud-config
runcmd:
  - mkdir -p /mnt/seed
  - mount -o ro LABEL=cidata /mnt/seed
  - sh /mnt/seed/guest.sh
EOF
cat > "$seed/guest.sh" << 'EOF'
#!/bin/sh
# In the guest, as root: the test, then its exit code, on ttyS1, then off.
code=0
sh /mnt/seed/run.sh > /dev/ttyS1 2>&1 || code=$?
echo "ISOLATION-EXIT $code" > /dev/ttyS1
poweroff
EOF
cat > "$seed/run.sh" << 'EOF'
set -eu
export DEBIAN_FRONTEND=noninteractive
echo "== Linux $(uname -r)"
systemctl --version | head -2
systemctl --version | grep -q '+BPF_FRAMEWORK' || { echo "This systemd has no BPF_FRAMEWORK"; exit 1; }
apt-get -qq update
apt-get -qq install -y --no-install-recommends nftables > /dev/null
mkdir -p /root/isolation
cp /mnt/seed/bun /mnt/seed/isolation.root.test.js /root/isolation/
chmod 755 /root/isolation/bun
cd /root/isolation
AGENTES_ROOT_TESTS=1 AGENTES_TEST_RUNNER=/mnt/seed/agentes-runner.mjs ./bun test ./isolation.root.test.js
EOF
genisoimage -quiet -output "$work/seed.iso" -volid cidata -rational-rock "$seed"

accel=tcg cpu=max
if [ -e /dev/kvm ]; then
  sudo chmod 666 /dev/kvm
  accel=kvm cpu=host
fi
echo "QEMU with $accel"
timeout 40m qemu-system-x86_64 -machine "q35,accel=$accel" -cpu "$cpu" -smp 2 -m 3072 \
  -drive "file=$work/disk.qcow2,if=virtio" \
  -drive "file=$work/seed.iso,media=cdrom,readonly=on" \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -display none -serial "file:$work/console.log" -serial stdio -no-reboot < /dev/null | tee "$work/out.log" || true
if ! tr -d '\r' < "$work/out.log" | grep -Eq 'ISOLATION-EXIT 0$'; then
  echo "== The guest's console"
  tail -n 100 "$work/console.log"
  exit 1
fi
