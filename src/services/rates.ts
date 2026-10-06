import axios from "axios";
import * as bitcoinJS from "bitcoinjs-lib";
import globals from "../globals";
const EX_RATE_API = "https://api.coingecko.com/api/v3/exchange_rates"

const reformatExchangeRates = ( rawExchangeRates ) => {
  const formattedExchangeRates = {
  };
  Object.keys( rawExchangeRates ).forEach( ( key )=> {
    const value = rawExchangeRates[ key ]
    if( value.type === 'fiat' ) {
      const fiatData = {
        '15m' : value.value, 'last' : value.value, 'buy' : value.value, 'sell' : value.value, 'symbol' : value.unit
      }
      formattedExchangeRates[ key.toUpperCase() ] = fiatData
    }
  } )
  return formattedExchangeRates
}

export const syncExchangeRates = async () => {
  const res = await axios.get(EX_RATE_API);
  if (res.status !== 200)
    console.log(
      `Exchange rate synchronisation failed at: ${Date.now()} w/ ${res.status}`
    );

  const exRates = res.data;
  if (Object.keys(exRates.rates).length) {
    globals.ExchangeRates = reformatExchangeRates(exRates.rates);
    return globals.ExchangeRates;
  } else
    console.log(
      `Exchange rate synchronisation failed at: ${Date.now()} due to empty data obj`
    );
};

export const getExchangeRates = async ( currencyCode ): Promise<{
  exchangeRates: any;
}> => {
  try {
    if (!(globals.ExchangeRates))  {
      const exchangeRates = await syncExchangeRates();
      if (!exchangeRates || !Object.keys(exchangeRates).length)
        console.log("Failed to initialise exchange rates");
    }
    if(currencyCode && globals && globals.ExchangeRates && globals.ExchangeRates[currencyCode]) return { exchangeRates: {[currencyCode]:globals.ExchangeRates[currencyCode]} };
    else return { exchangeRates: globals.ExchangeRates };
  } catch (err) {
    console.log("ExchangeRates failed", { err });
    return { exchangeRates: null };
  }
};
