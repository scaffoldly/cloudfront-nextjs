// PAGES MANIFEST
const pagesManifest = {};

// ROUTES MANIFEST
const routesManifest = {};

// Combine dynamic and static routes into a single array in the global scope, ensuring they exist or defaulting to empty arrays
const combinedRoutes = [
  ...(routesManifest.dynamicRoutes || []),
  ...(routesManifest.staticRoutes || []),
];

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const uri = request.uri;

  // Function to remove /pages prefix
  const removePagesPrefix = (path) => {
    return path.replace('/pages', '');
  };

  // Find matching route, ensuring route.regex is present
  const matchedRoute = combinedRoutes.find((route) => {
    if (!route.regex) return false;
    const regex = new RegExp(route.regex);
    return regex.test(uri) && !!pagesManifest[route.page];
  });

  if (matchedRoute) {
    request.uri = removePagesPrefix(pagesManifest[matchedRoute.page]);
    return request;
  }

  return request; // If no match, return original request
};
