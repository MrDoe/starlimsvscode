import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import * as fs from "fs";

/**
 * Service for handling git operations in the SLVSCODE workspace
 */
export class GitService {
    private workspacePath: string;
    private gitPath: string = "git";

    constructor(workspacePath: string) {
        this.workspacePath = workspacePath;
    }

    /**
     * Execute a git command
     * @param args Command arguments
     * @returns Promise with stdout or error
     */
    private async executeGitCommand(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const gitProcess = spawn(this.gitPath, args, {
                cwd: this.workspacePath,
                shell: true
            });

            let stdout = "";
            let stderr = "";

            gitProcess.stdout.on("data", (data) => {
                stdout += data.toString();
            });

            gitProcess.stderr.on("data", (data) => {
                stderr += data.toString();
            });

            gitProcess.on("close", (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(stderr || stdout));
                }
            });

            gitProcess.on("error", (error) => {
                reject(error);
            });
        });
    }

    /**
     * Check if git is installed and accessible
     * @returns true if git is available
     */
    public async isGitAvailable(): Promise<boolean> {
        try {
            await this.executeGitCommand(["--version"]);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Check if the workspace is a git repository
     * @returns true if the workspace is a git repository
     */
    public async isGitRepository(): Promise<boolean> {
        try {
            await this.executeGitCommand(["rev-parse", "--git-dir"]);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Initialize a git repository in the workspace
     * @returns true if successful
     */
    public async initializeRepository(): Promise<boolean> {
        try {
            await this.executeGitCommand(["init"]);
            vscode.window.showInformationMessage(`Git repository initialized in ${this.workspacePath}`);
            return true;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to initialize git repository: ${error.message}`);
            return false;
        }
    }

    /**
     * Get the list of changed files
     * @returns Array of changed file paths
     */
    public async getChangedFiles(): Promise<string[]> {
        try {
            // Get both staged and unstaged changes
            const status = await this.executeGitCommand(["status", "--porcelain"]);
            if (!status.trim()) {
                return [];
            }

            const files = status
                .split("\n")
                .filter(line => line.trim())
                .map(line => {
                    // Format: "XY filename" where XY are status codes
                    return line.substring(3).trim();
                });

            return files;
        } catch (error: any) {
            console.error("Failed to get changed files:", error);
            return [];
        }
    }

    /**
     * Get git diff for changed files
     * @returns git diff output
     */
    public async getDiff(): Promise<string> {
        try {
            const diff = await this.executeGitCommand(["diff", "HEAD"]);
            return diff;
        } catch (error: any) {
            console.error("Failed to get diff:", error);
            return "";
        }
    }

    /**
     * Stage all changes
     * @returns true if successful
     */
    public async stageAll(): Promise<boolean> {
        try {
            await this.executeGitCommand(["add", "."]);
            return true;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to stage changes: ${error.message}`);
            return false;
        }
    }

    /**
     * Commit changes with a message
     * @param message Commit message
     * @returns true if successful
     */
    public async commit(message: string): Promise<boolean> {
        try {
            await this.executeGitCommand(["commit", "-m", message]);
            return true;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to commit changes: ${error.message}`);
            return false;
        }
    }

    /**
     * Push changes to remote
     * @param remoteName Remote name (default: origin)
     * @param branchName Branch name (default: current branch)
     * @returns true if successful
     */
    public async push(remoteName: string = "origin", branchName?: string): Promise<boolean> {
        try {
            const args = ["push", remoteName];
            if (branchName) {
                args.push(branchName);
            }
            await this.executeGitCommand(args);
            return true;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to push changes: ${error.message}`);
            return false;
        }
    }

    /**
     * Add a remote repository
     * @param remoteName Remote name
     * @param remoteUrl Remote URL
     * @returns true if successful
     */
    public async addRemote(remoteName: string, remoteUrl: string): Promise<boolean> {
        try {
            await this.executeGitCommand(["remote", "add", remoteName, remoteUrl]);
            return true;
        } catch (error: any) {
            // If remote already exists, try to set the URL instead
            try {
                await this.executeGitCommand(["remote", "set-url", remoteName, remoteUrl]);
                return true;
            } catch (setUrlError: any) {
                vscode.window.showErrorMessage(`Failed to add remote: ${setUrlError.message}`);
                return false;
            }
        }
    }

    /**
     * Get the current branch name
     * @returns Branch name or empty string
     */
    public async getCurrentBranch(): Promise<string> {
        try {
            const branch = await this.executeGitCommand(["branch", "--show-current"]);
            return branch.trim();
        } catch (error) {
            return "";
        }
    }

    /**
     * Check if there are any changes to commit
     * @returns true if there are changes
     */
    public async hasChanges(): Promise<boolean> {
        const files = await this.getChangedFiles();
        return files.length > 0;
    }

    /**
     * Generate a commit message using GitHub Copilot
     * @returns Commit message or empty string if failed
     */
    public async generateCommitMessage(): Promise<string> {
        try {
            // Get the changed files and diff
            const changedFiles = await this.getChangedFiles();
            if (changedFiles.length === 0) {
                return "";
            }

            const diff = await this.getDiff();

            // Check if language model API is available
            if (!(vscode as any).lm) {
                console.log("Language model API not available");
                return "";
            }

            // Use VS Code's language model API (Copilot Chat)
            const models = await (vscode as any).lm.selectChatModels({
                vendor: "copilot",
                family: "gpt-4o"
            });

            if (models.length === 0) {
                console.log("No Copilot model available");
                return "";
            }

            const model = models[0];

            // Create the prompt for generating commit message
            const messages = [
                (vscode as any).LanguageModelChatMessage.User(
                    `Generate a concise commit message for the following changes. The commit message should:
- Be clear and descriptive
- Use present tense (e.g., "Add feature" not "Added feature")
- Be no more than 72 characters for the first line
- If needed, add a blank line followed by additional details

Changed files:
${changedFiles.join("\n")}

Diff (first 2000 chars):
${diff.substring(0, 2000)}

Provide ONLY the commit message, no explanations or markdown formatting.`
                )
            ];

            const request = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let commitMessage = "";
            for await (const fragment of request.text) {
                commitMessage += fragment;
            }

            return commitMessage.trim();
        } catch (error: any) {
            console.error("Failed to generate commit message:", error);
            return "";
        }
    }

    /**
     * Commit and push changes with an automatically generated message
     * @param customMessage Optional custom message (if not provided, will be generated)
     * @returns The commit message used, or empty string if failed
     */
    public async commitAndPush(customMessage?: string): Promise<string> {
        try {
            // Check if there are changes
            const hasChanges = await this.hasChanges();
            if (!hasChanges) {
                vscode.window.showInformationMessage("No changes to commit");
                return "";
            }

            // Generate commit message if not provided
            let commitMessage = customMessage;
            if (!commitMessage) {
                commitMessage = await this.generateCommitMessage();
                if (!commitMessage) {
                    commitMessage = "Update from STARLIMS VS Code extension";
                }

                // Show the generated message and allow editing
                commitMessage = await vscode.window.showInputBox({
                    title: "Git Commit Message",
                    prompt: "Review and edit the commit message",
                    value: commitMessage,
                    ignoreFocusOut: true,
                }) || commitMessage;
            }

            // Stage all changes
            const staged = await this.stageAll();
            if (!staged) {
                return "";
            }

            // Commit changes
            const committed = await this.commit(commitMessage);
            if (!committed) {
                return "";
            }

            // Get configuration for auto-push
            const config = vscode.workspace.getConfiguration("STARLIMS");
            const autoPush = config.get("git.autoPush", true);

            if (autoPush) {
                // Push changes
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: "Pushing changes to remote...",
                        cancellable: false
                    },
                    async () => {
                        const pushed = await this.push();
                        if (pushed) {
                            vscode.window.showInformationMessage("Changes committed and pushed successfully");
                        }
                    }
                );
            } else {
                vscode.window.showInformationMessage("Changes committed successfully");
            }

            return commitMessage;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Git operation failed: ${error.message}`);
            return "";
        }
    }
}
