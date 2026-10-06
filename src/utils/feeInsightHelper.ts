export const handlePriceAndChange = (data: any) => {
    let btc_price_usd = 0;
    let btc_price_change_percent = 0;
    if (data && data.market_data) {
      if (data.market_data.current_price && data.market_data.current_price.usd) {
        btc_price_usd = data.market_data.current_price.usd;
      }
      if (data.market_data.current_price && data.market_data.price_change_percentage_24h) {
        btc_price_change_percent = data.market_data.price_change_percentage_24h;
      }
    }
    
    return {
      btc_price_usd,
      btc_price_change_percent,
    };
  };


  export const handleSuggestedTxnFee = (data: any) => {
    if (data && data.fastestFee) {
      return data.fastestFee
    }
    return 0;
  };

  export const  timestampValidate=(timestamp: number, min: number)=>{
    const inputDate = new Date(timestamp);
    const currentDate = new Date();
    //@ts-expect-error
    const differenceInMilliseconds = currentDate - inputDate;
    const differenceInMinutes = differenceInMilliseconds / (1000 * 60);
    if (differenceInMinutes >= min) {
        return true;
    } else {
        return false;
    }
}