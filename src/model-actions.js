const tf = require('@tensorflow/tfjs-node');
const puppeteer = require('puppeteer');
const readline = require('readline');
const colors = require('colors');
const fs = require('fs').promises;
const Memory = require('../src/Memory');
const { performAction, proxy } = require('../src/game-mock');

function obstacleToVector(obstacle, vector, offset) {
    // Minimum distance (crash): 19
    // Maximum distance (appear): 625
    // Convert distance into int from 0-39.
    const distance = Math.min(39, Math.max(0, ~~((obstacle.xPos - 19) / 16)));
    vector[offset + distance] = 1;
    vector[offset+40] = obstacle.yPos;
    vector[offset+41] = obstacle.width;
    vector[offset+42] = obstacle.size;
}

function stateToTensor(state) {
    // shape of tensor: (88,)
    // [0-39]: distance to obstacle 0, one-hot encoded
    // [40]: y-position of obstacle 0
    // [41]: width of obstacle 0
    // [42]: height of obstacle 0
    // [43-85]: same for obstacle 1
    // [86]: jumping? 0/1
    // [87]: y-position of t-rex
    let vector = [
        0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0
    ];

    const obstacles = state.obstacles;
    if (obstacles.length > 0) {
        obstacleToVector(obstacles[0], vector, 0);

        if (obstacles.length > 1) {
            obstacleToVector(obstacles[1], vector, 43);
        }
    }

    // Jump yes/no:
    if (state.jumping) {
        vector[86] = 1;
    }
    vector[87] = state.ypos;
    //console.log("State: "+vector);

    return tf.tensor2d(vector, [1, 88]);
}

async function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

// update the target model's weights with the online model's weights
async function updateTargetModel(onlineModel, targetModel) {
    const onlineWeights = onlineModel.getWeights();
    await targetModel.setWeights(onlineWeights);
    await onlineModel.save('file://./dino-chrome-model/main');
    await targetModel.save('file://./dino-chrome-model/target');
    //test(onlineModel);
}

async function trainDinoModel(onlineModel, targetModel, proxy, episodes, memory, batchSize, gamma, epsilonStart, epsilonEnd, epsilonDecay, targetUpdateFrequency) {
    let epsilon = epsilonStart;
    let episodeReward = 0;

    // new session of training
    fs.appendFile('logs.txt', `\n\n------------------------------------------------------------------\n\n`)
        .catch((err) => {
            console.error('Failed to write to logs.txt:', err.message);
        });

    for (let episode = 0; episode < episodes; episode++) {
        await proxy.restart();
        let state = await proxy.state();

        while (!state.done) {
            const stateTensor = stateToTensor(state);
            const action = await selectAction(onlineModel, stateTensor, epsilon);
            performAction(action, proxy);

            // We need some time to pass, otherwise the next state will
            // be too close to the current state and model won't see the
            // result of it's action.
            // Instead of sleeping, we can do the optimization here. This
            // will take some time.
            if (memory.buffer.length >= batchSize) {
                try {
                    const experiences = memory.sample(batchSize);
                    const loss = await optimizeModel(onlineModel, targetModel, experiences, gamma, batchSize);
                    //console.log('Loss:', loss);
                } catch (e) {
                    console.log(e);
                }
            }

            // target is to spend 40 ms between two game states
            let nextState = await proxy.state();
            while (!nextState.done && nextState.time - state.time < 40) {
                await delay(5);
                nextState = await proxy.state();
            }

            const timeDelta = nextState.time - state.time;

            // Evaluate this step if and only if in time frame.
            // This will miss on some crashes but thats better
            // than having a crash assigned to the wrong action.
            if (timeDelta < 40 || timeDelta > 60) {
                if (!nextState.done) {
                    console.warn("Time delta < 40 ms or > 60ms: " + timeDelta);
                }
            }
            else {
                const nextStateTensor = stateToTensor(nextState);

                let reward;
                if (nextState.done) {
                    reward = -1;
                }
                else if (action === 1) {
                    /* experiment: make jumps expensive to avoid random jumps */
                    reward = 0;
                }
                else {
                    reward = 0.1;
                }
                episodeReward += reward;
                
                memory.add({ 
                    state: stateTensor, 
                    action, 
                    reward, 
                    nextState: nextStateTensor, 
                    done: nextState.done 
                }); // Fix the experience structure here

                // Decay epsilon (exploration rate)
                epsilon = epsilonEnd + (epsilonStart - epsilonEnd) * Math.exp(-1 * episode / epsilonDecay);
            }

            state = nextState;
        }

        // Update the target model's weights periodically
        if ((episode + 1) % targetUpdateFrequency === 0) {
            await updateTargetModel(onlineModel, targetModel);
        }

        // log after every episode and set episodeReward to 0
        fs.appendFile('logs.txt', `Episode: ${episode + 1}, Epsilon: ${epsilon}, Total Reward: ${episodeReward}\n`)
            .catch((err) => {
                console.error('Failed to write to logs.txt:', err.message);
            });
        episodeReward = 0;
    }
}

async function optimizeModel(onlineModel, targetModel, experiences, gamma, batchSize) {
    // To speed up, make predictions on full batch:
    const statesVectors = [];
    const nextStatesVectors = [];
    for (const { state, action, reward, nextState, done }
        of experiences) {
        statesVectors.push(state.dataSync());
        nextStatesVectors.push(nextState.dataSync());
    }
    const statesTensor = tf.tensor2d(statesVectors);
    const nextStatesTensor = tf.tensor2d(nextStatesVectors);

    const onlineModelQValuesTensor = onlineModel.apply(statesTensor);
    const onlineModelNextQValuesTensor = onlineModel.apply(nextStatesTensor);
    const targetModelNextQValuesTensor = targetModel.apply(nextStatesTensor);

    const onlineModelQValues = onlineModelQValuesTensor.dataSync();
    const targetModelNextQValues = targetModelNextQValuesTensor.dataSync();
    
    const noOfActions = targetModelNextQValuesTensor.shape[1];

    // Predict next actions based on online model for full batch:
    const onlineModelNextActions = onlineModelNextQValuesTensor.argMax(-1).dataSync();
    
    let targets = [];

    for (let i=0; i<experiences.length; i++) {
        const experience = experiences[i];

        let targetQValue;
        if (experience.done) {
            targetQValue = experience.reward;
        } else {
            // predict next action as argmax from online model
            let nextOnlineAction = onlineModelNextActions[i];
            // get target prediction on next action
            let nextTargetQValue = targetModelNextQValues[noOfActions*i + nextOnlineAction]
            targetQValue = experience.reward + gamma * nextTargetQValue;
        }

        const targetArray = onlineModelQValues.slice(i*noOfActions, (i+1)*noOfActions);
        if (false && experience.done) {
            console.log("Tensor: " + statesVectors[i]);
            console.log("Before: " + targetArray);
            targetArray[experience.action] = targetQValue;
            console.log("After: " + targetArray );
        }
        targetArray[experience.action] = targetQValue;
        targets.push(targetArray);
    }

    const targetTensor = tf.tensor2d(targets);

    //console.log("Inputs: "+statesTensor.dataSync());
    //console.log("Targets: "+targetTensor.dataSync());

    return onlineModel.fit(statesTensor, targetTensor, { epochs: 1, batchSize, shuffle: true, verbose: false }).then((history) => history.history.loss[0]);
}

function createModel() {
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 32, activation: 'relu', inputShape: [88] }));
    //model.add(tf.layers.dense({ units: 64, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 2, activation: 'linear' }));
    return model;
}

function compileModel(model) {
    model.compile({
        optimizer: tf.train.adam(0.0001),
        loss: tf.losses.meanSquaredError
    });
}

async function selectAction(model, state, epsilon) {
    if (Math.random() < epsilon) {
        // Choose a random action with probability epsilon
        return Math.floor(Math.random() * 2);
    } else {
        // Choose the best action according to the model
        //console.log("State: "+state.dataSync());
        const qValues = model.apply(state);
        //console.log("Preds: "+qValues.dataSync());
        const action = (await qValues.argMax(-1).data())[0];
        return action;
    }
}

async function test(model) {
    let vector = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,105,51,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,93];
    for (let i=19; i>=0; i--) {
        vector[i] = 1;
        const t = tf.tensor2d(vector, [1,88]);
        const qValues = model.apply(t);
        vector[86] = 1;
        vector[87] = 20;
        const t2 = tf.tensor2d(vector, [1,88]);
        const qValues2 = model.apply(t2);
        console.log("Preds for distance "+i+": "+qValues.dataSync()+" <-> "+qValues2.dataSync());
        vector[i] = 0;
        vector[86] = 0;
        vector[87] = 93;
    }
}

async function launchBrowser() {
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--mute-audio'] // Add this line to mute audio
    });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8080');
    return page;
}

async function setupModelTraining() {
    const page = await launchBrowser();
    await page.waitForFunction('Runner.instance_ !== undefined');
    const gameProxy = await proxy(page);

    // Load the saved model or create a new one if it doesn't exist
    let model;
    try {
        model = await tf.loadLayersModel('file://./dino-chrome-model/main/model.json');
        console.log('Loaded saved model'.green);
    } catch (error) {
        console.log('No saved model found, creating a new one'.yellow);
        model = createModel();
    }
    compileModel(model);

    // Load the target model from the same file location as the main model
    let targetModel;
    try {
        targetModel = await tf.loadLayersModel('file://./dino-chrome-model/main/model.json');
        console.log('Loaded target model'.green);
    } catch (error) {
        console.log('No target model found, cloning the main model'.yellow);
        targetModel = createModel();
    }
    compileModel(targetModel);

    const episodes = 10000;
    const memory = new Memory(40000);
    const batchSize = 64;
    const gamma = 0.9;// Discount factor
    const epsilonStart = 0.0; // Initial exploration rate
    const epsilonEnd = 0.01; // Final exploration rate
    const epsilonDecay = 200; // Decay rate for exploration
    const targetUpdateFrequency = 10; // How often to update the target model

    const saveAndExit = async() => {
        console.log('Saving models before exit...'.green);
        await model.save('file://./dino-chrome-model/main');
        console.log('Main model saved successfully.'.green);
        await targetModel.save('file://./dino-chrome-model/target');
        console.log('Target model saved successfully.'.green);
        process.exit();
    };

    // Handle SIGINT (Ctrl + C) using readline
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.on('SIGINT', async() => {
        rl.close(); // Close the readline interface
        await saveAndExit(); // Save the model and exit
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', async(error) => {
        console.error(`Uncaught exception: ${error.message.red}`);
        //await saveAndExit();
    });

    // Train the model here (additionally or for the first time)
    try {
        await trainDinoModel(model, targetModel, gameProxy, episodes, memory, batchSize, gamma, epsilonStart, epsilonEnd, epsilonDecay, targetUpdateFrequency);
    } catch (error) {
        console.error(`Error during training: ${error}`);
    }

    // Save the models to disk storage in separate folders
    await model.save('file://./dino-chrome-model/main');
    await targetModel.save('file://./dino-chrome-model/target');
}

module.exports = {
    setupModelTraining
};