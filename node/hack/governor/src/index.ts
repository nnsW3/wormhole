import {
  tryNativeToHexString,
  ChainId,
  CHAIN_ID_ALGORAND,
  CHAIN_ID_APTOS,
  CHAIN_ID_SUI,
  CONTRACTS,
  getOriginalAssetSui,
} from "@certusone/wormhole-sdk";

import { Connection, JsonRpcProvider } from "@mysten/sui.js";
import { arrayify, zeroPad } from "ethers/lib/utils";

const MinNotional = 0;
// Price change tolerance in %. Fallback to 30%
const PriceDeltaTolerance = process.env.PRICE_TOLERANCE ? Math.min(100, Math.max(0, parseInt(process.env.PRICE_TOLERANCE))) : 30;

const axios = require("axios");
const fs = require("fs");
const execSync = require("child_process").execSync;

const IncludeFileName = "./include_list.csv";
let includedTokens = new Map();
if (fs.existsSync(IncludeFileName)) {
  console.log("loading included symbols from file " + IncludeFileName);
  const data = fs.readFileSync(IncludeFileName, "utf-8");
  const lines = data.toString().replace(/\r\n/g, "\n").split("\n");
  for (let line of lines) {
    if (line !== "" && line[0] !== "#") {
      let fields = line.split(",", 10);
      if (fields.length < 2) {
        throw Error("line in include list does not contain enough fields");
      }

      includedTokens.set(fields[0] + ":" + fields[1].toLowerCase(), true);
    }
  }
}

/*
  "2Kc38rfQ49DFaKHQaWbijkE7fcymUMLY5guUiUsDmFfn": {
    "Symbol": "KURO",
    "Name": "Kurobi",
    "Address": "2Kc38rfQ49DFaKHQaWbijkE7fcymUMLY5guUiUsDmFfn",
    "CoinGeckoId": "kurobi",
    "Amount": 200,
    "Notional": 1.39,
    "TokenPrice": 0.00694548,
    "TokenDecimals": 6
  },
*/

// Get the existing token list to check for any extreme price changes and removed tokens
var existingTokenPrices = {};
var existingTokenKeys: string[] = [];
var newTokenKeys = {};

fs.readFile("../../pkg/governor/generated_mainnet_tokens.go", "utf8", function(_, doc) {
  var matches = doc.matchAll(/{chain: (?<chain>[0-9]+).+addr: "(?<addr>[0-9a-fA-F]+)".*symbol: "(?<symbol>.*)", coin.*price: (?<price>.*)}.*\n/g);
  for(let result of matches) {
    let {chain, addr, symbol, price} = result.groups;
    if (!existingTokenPrices[chain]) existingTokenPrices[chain] = {};
    existingTokenPrices[chain][addr] = parseFloat(price);
    existingTokenKeys.push(chain + "-" + addr + "-" + symbol);
  }
});

axios
  .get(
    "https://europe-west3-wormhole-message-db-mainnet.cloudfunctions.net/tvl"
  )
  .then(async (res) => {
    if (res.status != 200) {
      console.error("failed to read symbols, statusCode: %o", res.status);
      process.exit;
    }

    var content = "";

    content +=
      "// This file contains the token config to be used in the mainnet environment.\n";
    content += "//\n";
    content +=
      "// This file was generated: " +
      new Date().toString() +
      " using a min notional of " +
      MinNotional +
      "\n\n";
    content += "package governor\n\n";
    content += "func generatedMainnetTokenList() []tokenConfigEntry {\n";
    content += "\treturn []tokenConfigEntry {\n";

    var significantPriceChanges = [];
    var addedTokens = [];
    var removedTokens = [];
    var changedSymbols = [];
    var failedInputValidationTokens = [];
    var newTokensCount = 0;

    for (let chain in res.data.AllTime) {
      for (let addr in res.data.AllTime[chain]) {
        if (addr !== "*") {
          let data = res.data.AllTime[chain][addr];
          let notional = parseFloat(data.Notional);
          let key = chain + ":" + data.Address.toLowerCase();
          let includeIt = false;
          if (notional > MinNotional) {
            includeIt = true;
          } else {
            if (includedTokens.has(key)) {
              includeIt = true;
            }
          }
          if (includeIt) {
            includedTokens.delete(key);
            let chainId = parseInt(chain) as ChainId;
            let wormholeAddr: string;
            if (chainId == CHAIN_ID_ALGORAND) {
              if (
                data.Symbol.toLowerCase() === "algo" ||
                data.Address === "0"
              ) {
                wormholeAddr =
                  "0000000000000000000000000000000000000000000000000000000000000000";
              } else {
                // For Algorand, the address field is actually the asset ID so we can't do the usual tryNativeToHexString. Just convert it to hex and left pad with zeros.
                wormholeAddr = Buffer.from(
                  zeroPad(arrayify(Number.parseInt(data.Address)), 32)
                ).toString("hex");
              }
            } else {
              try {
                wormholeAddr = tryNativeToHexString(data.Address, chainId);
              } catch (e) {
                if (chainId == CHAIN_ID_SUI) {
                  // For Sui we look up the symbol from the RPC.
                  await (async () => {
                    const provider = new JsonRpcProvider(
                      new Connection({
                         fullnode: "https://fullnode.mainnet.sui.io",
                        //fullnode: "https://sui-mainnet.g.allthatnode.com/full/json_rpc",
                      })
                    );
                    const result = await getOriginalAssetSui(
                      provider,
                      CONTRACTS.MAINNET.sui.token_bridge,
                      data.Address
                    );
                    wormholeAddr = Buffer.from(result.assetAddress).toString(
                      "hex"
                    );
                  })();
                }
                if (wormholeAddr === undefined) {
                  console.log(
                    `Ignoring symbol '${data.Symbol}' on chain ${chainId} because the address '${data.Address}' is undefined`
                  );
                  continue;
                } else if (wormholeAddr === "") {
                  console.log(
                    `Ignoring symbol '${data.Symbol}' on chain ${chainId} because the address '${data.Address}' is invalid`
                  );
                  continue;
                }
              }
              
              // If the character list is violated, then skip the coin. The error is logged in the function if something happens to have some sort of check on it.
              if(!(safetyCheck(chain, wormholeAddr, data.Symbol, data.CoinGeckoId, data.TokenDecimals, data.TokenPrice, data.Address, notional))){
                failedInputValidationTokens.push(chain + "-" + wormholeAddr + "-" + data.symbol)
                continue; 
              }
            }

            // This is a new token
            if (existingTokenPrices[chain] == undefined || existingTokenPrices[chain][wormholeAddr] == undefined) {
              addedTokens.push(chain + "-" + wormholeAddr + "-" + data.Symbol);
            }
            // This is an existing token
            else {
              var previousPrice = existingTokenPrices[chain][wormholeAddr];

              // Price has decreased by > tolerance
              if (data.TokenPrice < previousPrice - (previousPrice * (PriceDeltaTolerance / 100))){
                significantPriceChanges.push({
                  token: chain + "-" + wormholeAddr + "-" + data.Symbol,
                  previousPrice: previousPrice,
                  newPrice: data.TokenPrice,
                  percentageChange: "-" + (100 - (data.TokenPrice / previousPrice) * 100).toFixed(1).toString()
                });
              }

              // We can also check for tokens that have increased in price, but this actually makes the governor
              // limits more aggressive, so is safer from a security point of view. Uncomment the below to also
              // be notified of tokens that have significantly increased in value

              // Price has increased by > tolerance
              // if (data.TokenPrice > previousPrice * ((100 + PriceDeltaTolerance) / 100)) {
              //   significantPriceChanges.push({
              //     token: chain + "-" + wormholeAddr + "-" + data.Symbol,
              //     previousPrice: previousPrice,
              //     newPrice: data.TokenPrice,
              //     percentageChange: "+" + (((data.TokenPrice / previousPrice) * 100) - 100).toFixed(1).toString()
              //   });
              // }
            }
            
            content +=
              "\t{ chain: " +
              chain +
              ', addr: "' +
              wormholeAddr +
              '", symbol: "' +
              data.Symbol +
              '", coinGeckoId: "' +
              data.CoinGeckoId +
              '", decimals: ' +
              data.TokenDecimals +
              ", price: " +
              data.TokenPrice +
              " }, // Addr: " +
              data.Address +
              ", Notional: " +
              notional +
              "\n";

            // We add in the "=" character to ensure an undefined symbol
            // does not mess up the removed tokens logic
            newTokenKeys[chain + "-" + wormholeAddr] = "=" + data.Symbol;
            newTokensCount += 1;
          }
        }
      }
    }

    for (var token of existingTokenKeys) {
      // A token has been removed from the token list 
      // We cut the symbol off the end of the key as it's possible for a token to change its symbol
      var tokenParts = token.split("-");
      var newTokenSymbol = newTokenKeys[tokenParts[0] + "-" + tokenParts[1]];
      if (!newTokenSymbol) {
        removedTokens.push(token);
      }
      // The token symbol has changed
      // We take a substring of the symbol to cut the "=" character we added above
      else if (tokenParts[0] + "-" + tokenParts[1] + "-" + newTokenSymbol.substring(1) != token) {
        changedSymbols.push(token + "->" + newTokenSymbol);
      }
    }

    // Sanity check to make sure the script is doing what we think it is
    if (existingTokenKeys.length + addedTokens.length - removedTokens.length != newTokensCount) {
      console.error(`Num existing tokens (${existingTokenKeys.length}) + Added tokens (${addedTokens.length}) - Removed tokens (${removedTokens.length}) != Num new tokens (${newTokensCount})`);
      process.exit(1);
    }

    var changedContent = "```\nTokens before = " + existingTokenKeys.length;
    changedContent += "\nTokens after = " + newTokensCount;
    changedContent += "\n\nTokens added = " + addedTokens.length + ":\n<WH_chain_id>-<WH_token_addr>-<token_symbol>\n\n";
    changedContent += JSON.stringify(addedTokens, null, 1);
    changedContent += "\n\nTokens removed = " + removedTokens.length + ":\n<WH_chain_id>-<WH_token_addr>-<token_symbol>\n\n";
    changedContent += JSON.stringify(removedTokens, null, 1);
    changedContent += "\n\nTokens with changed symbols = " + changedSymbols.length + ":\n<WH_chain_id>-<WH_token_addr>-<old_token_symbol>-><new_token_symbol>\n\n";

    changedContent += "\n\nTokens with invalid symbols = " + failedInputValidationTokens.length + ":\n<WH_chain_id>-<WH_token_addr>-<token_symbol>\n\n";
    changedContent += JSON.stringify(failedInputValidationTokens, null, 1);

    changedContent += "\n\nTokens with significant price drops (>" + PriceDeltaTolerance + "%) = " + significantPriceChanges.length + ":\n\n"
    changedContent += JSON.stringify(significantPriceChanges, null, 1);
    changedContent += "\n```";

    await fs.writeFileSync(
      "./changes.txt",
      changedContent,
      {
        flag: "w+",
      }
    );

    content += "\t}\n";
    content += "}\n";

    await fs.writeFileSync(
      "../../pkg/governor/generated_mainnet_tokens.go",
      content,
      {
        flag: "w+",
      }
    );

    execSync("go fmt ../../pkg/governor/generated_mainnet_tokens.go");

    if (includedTokens.size != 0) {
      for (let [key, value] of includedTokens) {
        console.error(`Did not find included token '${key}' in query result!`);
      }
    }

    console.log(
      '\nPlease do "go run check_query.go" to verify the Coin Gecko query still works before doing a commit.'
    );
  })
  .catch((error) => {
    console.error("Request error:", error);
  });


/*
  Perform type checks on the incoming values
  Check for a denylist set of characters

  If either of these fail, we reject adding the token.

  Example data: 30 000000000000000000000000b5c457ddb4ce3312a6c5a2b056a1652bd542a208 O404 omni404 18 1128.69 0xb5c457ddb4ce3312a6c5a2b056a1652bd542a208 7.4832146999999996
*/
function safetyCheck(chain, wormholeAddr, symbol, coinGeckoId, tokenDecimals, tokenPrice, address, notional)  : boolean{
  
  if(isNaN(chain)){
    console.log("Invalid chain ID ", chain, " provided")
    return false; 
  }

  if(inputHasInvalidChars(wormholeAddr)){
    console.log("Invalid wormhole address ", wormholeAddr, " provided")
    return false; 
  }

  if(inputHasInvalidChars(symbol)){
    console.log("Invalid token symbol ", symbol, " provided")
    return false; 
  }

  if(inputHasInvalidChars(coinGeckoId)){
    console.log("Invalid coin gecko id ", coinGeckoId, " provided")
    return false; 
  }

  if(isNaN(tokenDecimals)){
    console.log("Invalid token decimals ", tokenDecimals, " provided")
    return false; 
  }

  if(isNaN(tokenPrice)){
    console.log("Invalid token price ", tokenPrice, " provided")
    return false; 
  }

  if(inputHasInvalidChars(address)){
    console.log("Invalid address ", address, " provided")
    return false; 
  }
  if(isNaN(notional)){
    console.log("Invalid notional", notional, " provided")
    return false; 
  }

  return true; 
}

// Checks whether an illegal character is present in the provided string
// If a character is found then return true. Otherwise, return false. 
function inputHasInvalidChars(input) : boolean{
  var deny_list = ["\"", "%", "\n","\r", "\\","{","}","/","'","[","]","(",")"]
  for(var char of deny_list) {
    if(input.includes(char)){
      return true; 
    }
  }

  return false; 
}
