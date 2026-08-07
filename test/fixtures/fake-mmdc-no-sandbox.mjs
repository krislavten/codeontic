// Stands in for mmdc on a machine whose Chromium sandbox cannot start.
// Reproduces the real stderr from this repo's first CI run (ubuntu-24.04,
// AppArmor restricting unprivileged user namespaces) so the classifier is
// tested against the actual text it will meet, not a paraphrase.
process.stderr.write(
  "Error: Failed to launch the browser process!\n" +
    "[0722/094450.718161:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:128] " +
    "No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has " +
    "disabled unprivileged user namespaces with AppArmor, see ...\n" +
    "TROUBLESHOOTING: https://pptr.dev/troubleshooting\n",
);
process.exit(1);
