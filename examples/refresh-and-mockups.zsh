#!/bin/zsh
# Refresh a local CCS cache and generate mockups for selected packages.

set -euo pipefail
setopt null_glob dot_glob

usage() {
  cat <<'EOF'
Usage: refresh-and-mockups.zsh [-c cache-dir] [-m mockups-dir] [-p package]...

Refreshes the cache from CCS and generates mockups. Repeat -p to select packages. With no -p options, the
default packages are CLP_bills, CLP_letters, CLP_braille, CLP_Emails, and
CLP_statements.
EOF
}

cache_dir="./comms-cache"
mockups_root="./mockups"
packages=()

while getopts ':c:m:p:h' option; do
  case "$option" in
    c) cache_dir="$OPTARG" ;;
    m) mockups_root="$OPTARG" ;;
    p) packages+=("$OPTARG") ;;
    h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if (( ! ${#packages[@]} )); then
  packages=(CLP_bills CLP_letters CLP_braille CLP_Emails CLP_statements)
fi

command -v occs >/dev/null || {
  print -u2 "occs is not available on PATH."
  exit 1
}
mkdir -p "$cache_dir" "$mockups_root"
print "Refreshing the communications cache..."
occs get-everything --output "$cache_dir"

for package_name in "${packages[@]}"; do
  [[ -d "$cache_dir/packages/$package_name" ]] || {
    print -u2 "Package $package_name was not found in $cache_dir/packages."
    exit 1
  }
  package_mockups="$mockups_root/$package_name"
  mkdir -p "$package_mockups"
  print "Generating mockups for $package_name..."
  occs mockup --cache "$cache_dir" --package "$package_name" --all --output "$package_mockups"
done

print "Done. Mockups are in $mockups_root."
