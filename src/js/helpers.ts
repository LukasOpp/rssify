export function formatURL(url: string) {
    try {
      let parsedUrl = new URL(url);
  
      // If the URL object is created successfully but the protocol is not HTTPS, change it to HTTPS.
      if (parsedUrl.protocol !== 'https:') {
        parsedUrl.protocol = 'https:';
        return parsedUrl.toString();
      }
  
      // Return the original URL if it already uses HTTPS.
      return url;
    } catch (error: any) {
      // If the input does not have a protocol, prepend 'https://'
      if (error.code === 'ERR_INVALID_URL') {
        return `https://${url}`;
      }
      // For any other error, throw it.
      throw error;
    }
  }