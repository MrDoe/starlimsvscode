import * as vscode from "vscode";
import { spawn } from "child_process";

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
                shell: false
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
}
