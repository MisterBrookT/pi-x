// Pix Proactive launcher: a stable, signed app identity for macOS privacy prompts.
// It starts node as a child (so macOS attributes access to this app, not to whichever node build is installed).
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
static pid_t child;
static void fwd(int s) { if (child > 0) kill(child, s); }
int main(int argc, char **argv) {
	if (argc < 2) return 2;
	signal(SIGTERM, fwd); signal(SIGINT, fwd); signal(SIGHUP, fwd);
	if (posix_spawn(&child, argv[1], NULL, NULL, argv + 1, environ) != 0) return 127;
	int st; while (waitpid(child, &st, 0) < 0) {}
	return WIFEXITED(st) ? WEXITSTATUS(st) : 1;
}
