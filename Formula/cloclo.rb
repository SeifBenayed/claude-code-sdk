class Cloclo < Formula
  desc "Multi-provider AI coding agent CLI — open-source Claude Code alternative"
  homepage "https://github.com/anthropics/cloclo"
  url "https://registry.npmjs.org/cloclo/-/cloclo-1.0.1.tgz"
  sha256 "" # TODO: fill after npm publish
  license "MIT"

  depends_on "node@20"

  def install
    # Install the main files
    libexec.install "claude-native.mjs"
    libexec.install "ink-ui.mjs" if File.exist?("ink-ui.mjs")
    libexec.install "package.json"

    # Install npm dependencies into libexec
    cd libexec do
      system "npm", "install", "--omit=dev", "--no-audit", "--no-fund"
    end

    # Create wrapper that uses Homebrew's node
    (bin/"cloclo").write <<~EOS
      #!/usr/bin/env bash
      exec "#{Formula["node@20"].opt_bin}/node" "#{libexec}/claude-native.mjs" "$@"
    EOS
  end

  test do
    assert_match "cloclo", shell_output("#{bin}/cloclo --help 2>&1")
    assert_match "Interactive REPL", shell_output("#{bin}/cloclo --help 2>&1")
  end
end
