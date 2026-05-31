import { z } from "zod";
import { Sandbox} from "@e2b/code-interpreter";
import { openai, createAgent, createTool, createNetwork, Tool, Message, createState } from "@inngest/agent-kit";

import { FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "@/prompt";

import { inngest } from "./client";
import { getSandbox, lastAssistantTextMessageContent } from "./util";
import { prisma } from "@/lib/db";

const nvidiaModel = openai({
  model: "meta/llama-3.3-70b-instruct",
  apiKey: process.env.NVIDIA_API_KEY,
  baseUrl: "https://integrate.api.nvidia.com/v1",
  defaultParameters: {
    temperature: 1,
    top_p: 0.95,
    max_completion_tokens: 16384,
  },
});

interface AgentState{
  summary: string,
  files:{[path: string]: string};
};

export const codeAgentFunctions = inngest.createFunction(
  { id: "code-agent" },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    const sandboxId = await step.run("get-sandbox-id", async () => {
      const sandbox = await Sandbox.create("vibe-nextjs-test-8788");
      
      await sandbox.setTimeout(60_000 * 10 * 3);
      await sandbox.commands.run("npm config set strict-ssl false");
      return sandbox.sandboxId;
    });


    const previousMessages = await step.run("get-previous-message", async()=>{
      const formattedMessages: Message[] = [];

      const messages = await prisma.message.findMany({
        where: {
          projectId: event.data.projectId,
        },
        orderBy:{
          createdAt: "desc",
        },
        take: 5,
      });

      var index = 1;
      for( const message of messages){
        formattedMessages.push({
          type: "text",
          role: message.role === "ASSISTANT" ? "assistant" : "user",
          content: `${index} message: ${message.content}`,
        })
        index++;
      }
      return formattedMessages.reverse();
    });

    const state = createState<AgentState>(
      {
        summary: "",
        files: {},
      },
      {
          messages: previousMessages,
      },
    );

    const codeAgent = createAgent<AgentState>({
      name: "code-agent",
      description: "An expert coding agent",
      system: PROMPT,
      model: nvidiaModel,
      tools: [
        createTool({
          name: "terminal",
          description: "Use the terminal to run commands",
          parameters: z.object({
            command: z.string()
          }),
          handler: async({command}, {step}) => {
            return await step ?.run("terminal", async() => {
              const buffers = {stdout:"", stderr: ""};

              try{
                const sandbox = await getSandbox(sandboxId);
                const result = await sandbox.commands.run(command, {
                  timeoutMs: 120_000,
                  onStdout: (data: string) => {
                    buffers.stdout += data;
                  },
                  onStderr: (data: string) => {
                    buffers.stderr += data;
                  }
                });
                return result.stdout;
              }catch(e){
                console.error(
                  `Command failed: ${e} \n stdout: ${buffers.stdout} \n stderr: ${buffers.stderr}`,
                );
                return `Command failed: ${e} \n stdout: ${buffers.stdout} \n stderr: ${buffers.stderr}`;
              }
            })
          }
        }
      ),
      createTool({
          name: "createOrUpdateFiles",
          description: "Create or update files in the sandbox",
          parameters: z.object({ 
            files: z.array(
              z.object({ 
                path: z.string(),
                content: z.string(),
              }),
            ),
          }),
          handler: async(
            { files },
            { step, network }: Tool.Options<AgentState>
          ) => {
            const newFiles = await step?.run("createOrUpdateFiles", async() => {
              try {
                const updatedFiles = network.state.data.files || {};
                const sandbox = await getSandbox(sandboxId);
                for(const file of files){
                  await sandbox.files.write(file.path, file.content);
                  updatedFiles[file.path] = file.content;
                }

                return updatedFiles;
              } catch (e) {

                console.log("******** ERROR ********: " +e);
                return "Error: "+ e;
              }
            });

            if(typeof newFiles === "object") {
              network.state.data.files = newFiles;
            }
          }
        }),

        createTool({
          name: "readFiles",
          description: "Read files from the sandbox",
          parameters: z.object({
            files: z.array(z.string()),
          }),
          handler: async({files}, {step}) =>{
            return await step?.run("readFiles", async() => {
              try {
                const sandbox = await getSandbox(sandboxId);
                const contents = [];

                for(const file of files){
                  const content = await sandbox.files.read(file);
                  contents.push({path: file, content});
                }
                return JSON.stringify(contents);
              } catch (e) {
                return "Error: "+ e;
              }
            })
          },
        })
      ],
      lifecycle:{
        onResponse: async({result, network}) => {
          const lastAssistantMessageText = 
          lastAssistantTextMessageContent(result);
          if(lastAssistantMessageText && network){
            if(lastAssistantMessageText.includes("<task_summary>")){
              network.state.data.summary = lastAssistantMessageText;
            }
          }
          return result;
        },
      },
    });

    const network = createNetwork<AgentState>({
      name: "coding-agent-network",
      agents: [codeAgent],
      maxIter: 20,
      defaultState: state,
      router: async({network}) =>{
        const summary = network.state.data.summary;

        if(summary){
          return;
        }

        return codeAgent;
      },
    });

    const result = await network.run(event.data.value, {state});

    const fragmentTitleGenerator = createAgent({
      name: "fragment-title-generator",
      description: "A fragment title generator",
      system: FRAGMENT_TITLE_PROMPT,
      model: nvidiaModel
    });

     const responseGenerator = createAgent({
      name: "response-generator",
      description: "A response generator",
      system: RESPONSE_PROMPT,
      model: nvidiaModel
    });

    const {output: fragmentTitleOutput} = await fragmentTitleGenerator.run(result.state.data.summary);
    const {output: responseOutput} = await responseGenerator.run(result.state.data.summary);

    const generateFragementTitle = ()=>{
      if(fragmentTitleOutput[0].type !== "text"){
        return "Fragment";
      }

      if(Array.isArray(fragmentTitleOutput[0].content)){
        return fragmentTitleOutput[0].content.map((txt)=>txt).join("");
      }else{
        return fragmentTitleOutput[0].content;
      } 
    }

    const generateResponse = ()=>{
      if(responseOutput[0].type !== "text"){
        return "Here we go";
      }

      if(Array.isArray(responseOutput[0].content)){
        return responseOutput[0].content.map((txt)=>txt).join("");
      }else{
        return responseOutput[0].content;
      } 
    }

     const isError = 
      !result.state.data.summary || Object.keys(result.state.data.files || {}).length === 0;

      const sandboxUrl = await step.run("get-sandbox-url", async () => {
        const sandbox = await getSandbox(sandboxId);
        const host = sandbox.getHost(3000)
        return `https://${host}`;
      }) 

    await step.run("save-result", async() => {

      if(isError){
        return await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: "Error: Unable to complete the request. Please try again.",
            role: "ASSISTANT",
            type: "ERROR",
          }
        })}
      

      return await prisma.message.create({
        data:{
          projectId: event.data.projectId,
          content: generateResponse(),
          role: "ASSISTANT",
          type: "RESULT",
          fragment: {
            create: {
              sandboxUrl: sandboxUrl,
              title: generateFragementTitle(),
              files: result.state.data.files,
            }
          }
        }
      })
    })

      return {
        url: sandboxUrl,
        title: "Fragement",
        files: result.state.data.files,
        summary: result.state.data.summary,
      };
    },
);
